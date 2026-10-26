"""Free-first, privacy-preserving geocoding tools for Reva.

MongoDB remains authoritative for private GPS. These functions only translate a
coordinate supplied by the authorized application layer, or a place name from
the user's question, into a coarse administrative label.
"""
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

USER_AGENT = os.getenv("GEOCODING_USER_AGENT", "RevaLocationAssistant/1.0 (location labels)")
HTTP_TIMEOUT = max(2.0, min(float(os.getenv("GEOCODING_TIMEOUT_SECONDS", "4")), 8.0))
CACHE_TTL_DAYS = max(1, min(int(os.getenv("GEOCODING_CACHE_TTL_DAYS", "30")), 365))
_NOMINATIM_LOCK = threading.Lock()
_LAST_NOMINATIM_REQUEST = 0.0
_MEMORY_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_MEMORY_LOCK = threading.Lock()


def _http_json(url: str, headers: dict[str, str] | None = None) -> Any:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError("geocoder returned HTTP " + str(response.status))
        payload = json.loads(response.read(1_000_000).decode("utf-8"))
    if not isinstance(payload, (dict, list)):
        raise ValueError("geocoder returned an unsupported response")
    return payload


def _nominatim_get(url: str) -> dict[str, Any]:
    """Respect the public Nominatim endpoint's one-request-per-second policy."""
    global _LAST_NOMINATIM_REQUEST
    with _NOMINATIM_LOCK:
        wait = 1.05 - (time.monotonic() - _LAST_NOMINATIM_REQUEST)
        if wait > 0:
            time.sleep(wait)
        _LAST_NOMINATIM_REQUEST = time.monotonic()
        return _http_json(url)


def _clean_address(address: dict[str, Any], feature_name: str | None = None) -> dict[str, Any]:
    road = address.get("road") or address.get("pedestrian") or address.get("footway") or address.get("residential")
    locality = (
        address.get("neighbourhood") or address.get("suburb") or address.get("quarter") or address.get("hamlet")
        or address.get("city") or address.get("town") or address.get("municipality")
        or address.get("village") or address.get("locality") or address.get("city_district")
        or address.get("suburb") or address.get("neighbourhood") or address.get("county")
    )
    city = address.get("city") or address.get("town") or address.get("municipality") or locality
    state = address.get("state") or address.get("state_district") or address.get("region") or address.get("county")
    country = address.get("country")
    result = {
        "road": str(road)[:160] if road else None,
        "locality": str(locality)[:120] if locality else None,
        "city": str(city)[:120] if city else None,
        "state": str(state)[:120] if state else None,
        "country": str(country)[:120] if country else None,
        "label": ", ".join(str(x) for x in (locality, city if city != locality else None, state, country) if x),
        "feature": str(feature_name)[:160] if feature_name else None,
    }
    result["label"] = result["label"] or result["feature"] or None
    return result


def _photon_address(properties: dict[str, Any]) -> dict[str, Any]:
    return _clean_address({
        "road": properties.get("street"),
        "city": properties.get("city") or properties.get("town"),
        "municipality": properties.get("municipality"),
        "village": properties.get("village"),
        "locality": properties.get("locality"),
        "suburb": properties.get("suburb") or properties.get("district"),
        "county": properties.get("county"),
        "state": properties.get("state"),
        "country": properties.get("country"),
    }, properties.get("name"))


def _cache_get(cache_collection: Any, key: str) -> dict[str, Any] | None:
    now = datetime.now(timezone.utc)
    with _MEMORY_LOCK:
        entry = _MEMORY_CACHE.get(key)
        if entry and entry[0] > time.time():
            return dict(entry[1])
        _MEMORY_CACHE.pop(key, None)
    if cache_collection is not None:
        try:
            doc = cache_collection.find_one({"cacheKey": key, "expiresAt": {"$gt": now}})
            if doc and isinstance(doc.get("result"), dict):
                result = dict(doc["result"])
                with _MEMORY_LOCK:
                    _MEMORY_CACHE[key] = (time.time() + 3600, result)
                return result
        except Exception as exc:
            print("[Reva RAG] geocoding cache read failed: " + type(exc).__name__, flush=True)
    return None


def _cache_put(cache_collection: Any, key: str, result: dict[str, Any]) -> None:
    expiry = datetime.now(timezone.utc) + timedelta(days=CACHE_TTL_DAYS)
    with _MEMORY_LOCK:
        _MEMORY_CACHE[key] = (time.time() + 3600, dict(result))
        if len(_MEMORY_CACHE) > 1000:
            oldest = next(iter(_MEMORY_CACHE))
            _MEMORY_CACHE.pop(oldest, None)
    if cache_collection is not None:
        try:
            cache_collection.update_one(
                {"cacheKey": key},
                {"$set": {"cacheKey": key, "result": result, "expiresAt": expiry}},
                upsert=True,
            )
        except Exception as exc:
            print("[Reva RAG] geocoding cache write failed: " + type(exc).__name__, flush=True)


def _valid_coordinates(latitude: Any, longitude: Any) -> tuple[float, float] | None:
    try:
        lat, lon = float(latitude), float(longitude)
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return None
        if lat != lat or lon != lon:
            return None
        return lat, lon
    except (TypeError, ValueError):
        return None


def reverse_geocode(latitude: Any, longitude: Any, cache_collection: Any = None) -> dict[str, Any]:
    coords = _valid_coordinates(latitude, longitude)
    if coords is None:
        return {"ok": False, "label": None, "locality": None, "city": None, "state": None, "country": None, "source": None, "error": "invalid_coordinates"}
    lat, lon = coords
    key = "reverse:" + format(lat, ".3f") + "," + format(lon, ".3f")
    cached = _cache_get(cache_collection, key)
    if cached:
        return {**cached, "cached": True}
    errors = []
    # Nominatim is the primary free provider. Coarse zoom fallback avoids returning
    # an empty result when the nearest detailed map object has no address fields.
    for zoom in (14, 10):
        try:
            query = urllib.parse.urlencode({
                "format": "jsonv2", "lat": str(lat), "lon": str(lon),
                "zoom": str(zoom), "addressdetails": "1",
            })
            data = _nominatim_get("https://nominatim.openstreetmap.org/reverse?" + query)
            result = _clean_address(data.get("address") or {}, data.get("name"))
            if result.get("label"):
                result.update({"ok": True, "source": "nominatim", "attribution": "© OpenStreetMap contributors", "cached": False})
                _cache_put(cache_collection, key, result)
                return result
        except Exception as exc:
            errors.append("nominatim:" + type(exc).__name__)
    # Independent free fallback for administrative locality/city labels.
    try:
        query = urllib.parse.urlencode({"latitude": str(lat), "longitude": str(lon), "localityLanguage": "en"})
        data = _http_json("https://api.bigdatacloud.net/data/reverse-geocode-client?" + query)
        locality_info = data.get("localityInfo", {}).get("administrative", [])
        locality = data.get("locality") or data.get("localityName")
        city = data.get("city") or locality or next(
            (item.get("name") for item in locality_info if any(
                word in str(item.get("description", "")).lower() for word in ("city", "town", "municipality")
            )), None
        )
        result = _clean_address({
            "city": city, "locality": locality, "state": data.get("principalSubdivision"),
            "country": data.get("countryName"),
        })
        if result.get("label"):
            result.update({"ok": True, "source": "bigdatacloud", "attribution": "BigDataCloud", "cached": False})
            _cache_put(cache_collection, key, result)
            return result
    except Exception as exc:
        errors.append("bigdatacloud:" + type(exc).__name__)
    return {
        "ok": False, "label": None, "locality": None, "city": None, "state": None,
        "country": None, "source": None, "cached": False, "error": ",".join(errors) or "no_result",
    }


def forward_geocode(place_query: str, cache_collection: Any = None) -> dict[str, Any]:
    query_text = " ".join(str(place_query or "").split())[:180]
    if len(query_text) < 2:
        return {"ok": False, "label": None, "locality": None, "city": None, "state": None, "country": None, "source": None, "error": "query_too_short"}
    key = "forward:" + query_text.casefold()
    cached = _cache_get(cache_collection, key)
    if cached:
        return {**cached, "cached": True}
    errors = []
    try:
        params = urllib.parse.urlencode({"format": "jsonv2", "q": query_text, "limit": "1", "addressdetails": "1"})
        data = _nominatim_get("https://nominatim.openstreetmap.org/search?" + params)
        if isinstance(data, list) and data:
            item = data[0]
            result = _clean_address(item.get("address") or {}, item.get("name"))
            result.update({"ok": bool(result.get("label")), "source": "nominatim", "attribution": "© OpenStreetMap contributors", "cached": False})
            if result["ok"]:
                _cache_put(cache_collection, key, result)
                return result
    except Exception as exc:
        errors.append("nominatim:" + type(exc).__name__)
    # Photon is an independent OSM-based free fallback for place-name searches.
    try:
        params = urllib.parse.urlencode({"q": query_text, "limit": "1", "lang": "en"})
        data = _http_json("https://photon.komoot.io/api/?" + params)
        features = data.get("features") or []
        if features:
            properties = features[0].get("properties") or {}
            result = _photon_address(properties)
            result.update({"ok": bool(result.get("label")), "source": "photon", "attribution": "© OpenStreetMap contributors", "cached": False})
            if result["ok"]:
                _cache_put(cache_collection, key, result)
                return result
    except Exception as exc:
        errors.append("photon:" + type(exc).__name__)
    return {
        "ok": False, "label": None, "locality": None, "city": None, "state": None,
        "country": None, "source": None, "cached": False, "error": ",".join(errors) or "no_result",
    }


def location_tool_route(question: str, context: dict[str, Any]) -> str:
    """Select reverse geocoding for authorized people, forward geocoding for public places."""
    import re
    text = str(question or "").casefold()
    people = [
        person for person in (context.get("currentLocations") or [])
        if isinstance(person, dict) and person.get("username")
    ]
    named_people = [
        person for person in people
        if str(person.get("username")).casefold() not in {"you", "me", "self"}
        and re.search(r"\b" + re.escape(str(person.get("username")).casefold()) + r"\b", text)
    ]
    asks_self = bool(re.search(r"\b(where am i|where was i|my current location|what city am i|what state am i|what country am i)\b", text))
    reverse_language = any(term in text for term in (
        "where am i", "where is", "where are", "what city", "which city",
        "what town", "what locality", "what state", "what country", "what road", "which road", "what street", "which street", "current location",
        "located", "location right now", "currently at", "where was",
    ))
    if reverse_language and (asks_self or named_people):
        targets = [person for person in people if (
            str(person.get("username")).casefold() in {"you", "me", "self"}
            if asks_self else person in named_people
        )]
        if any(_valid_coordinates(p.get("latitude"), p.get("longitude")) for p in targets):
            return "reverse_geocode"
        # A friend with no supplied GPS must not be looked up as a public place.
        return "none"
    personal_reference = any(term in text for term in (
        "my friend", "my friends", "a friend", "the friend", "my location",
        "user one", "user two", "my family", "my brother", "my sister",
    ))
    public_place_language = any(term in text for term in (
        "where is ", "where's ", "locate ", "which state is ", "what state is ",
        "what country is ", "what city is ",
    ))
    if public_place_language and not named_people and not personal_reference:
        return "forward_geocode"
    return "none"


def resolve_location_tools(question: str, context: dict[str, Any], cache_collection: Any = None) -> dict[str, Any]:
    """Run the selected location tool only against supplied/authorized coordinates."""
    route = location_tool_route(question, context)
    results = []
    if route == "reverse_geocode":
        import re
        text = str(question or "").casefold()
        people = [p for p in (context.get("currentLocations") or []) if isinstance(p, dict)]
        named = [p for p in people if p.get("username") and str(p.get("username")).casefold() not in {"you", "me", "self"}
                 and re.search(r"\b" + re.escape(str(p.get("username")).casefold()) + r"\b", text)]
        asks_self = bool(re.search(r"\b(where am i|where was i|my current location|what city am i|what state am i|what country am i)\b", text))
        targets = ([p for p in people if str(p.get("username") or "").casefold() in {"you", "me", "self"}]
                   if asks_self else named if named else people[:20])
        for person in targets[:20]:
            coords = _valid_coordinates(person.get("latitude"), person.get("longitude"))
            if coords is None:
                continue
            geo = reverse_geocode(coords[0], coords[1], cache_collection)
            results.append({
                "person": str(person.get("username") or "user")[:60],
                "label": geo.get("label"), "road": geo.get("road"), "locality": geo.get("locality"), "city": geo.get("city"),
                "state": geo.get("state"), "country": geo.get("country"),
                "source": geo.get("source"), "attribution": geo.get("attribution"), "ok": geo.get("ok"),
                "lastSeen": person.get("lastSeen"),
                "sharingEnabled": person.get("sharingEnabled"),
            })
    elif route == "forward_geocode":
        # This only resolves public place names; never queries a person's identity.
        import re
        match = re.search(r"(?:where is|where's|locate|which state is|what state is|what country is|what city is)\s+(.+?)[?!.]*$", question, re.I)
        query_text = match.group(1).strip() if match else ""
        query_text = re.sub(r"\b(in the world|located|situated)\b", "", query_text, flags=re.I).strip()
        if query_text:
            geo = forward_geocode(query_text, cache_collection)
            results.append({
                "query": query_text, "label": geo.get("label"), "road": geo.get("road"), "locality": geo.get("locality"),
                "city": geo.get("city"), "state": geo.get("state"), "country": geo.get("country"),
                "source": geo.get("source"), "attribution": geo.get("attribution"), "ok": geo.get("ok"),
            })
    return {"route": route, "results": results}
