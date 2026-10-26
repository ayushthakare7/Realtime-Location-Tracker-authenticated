const NearbyPlaceCache = require("../models/NearbyPlaceCache");
const cache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let lastRequestAt = 0;

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function classify(tags = {}) {
  if (tags.highway) return "road";
  if (tags.university || tags.amenity === "university") return "university";
  if (tags.college || tags.amenity === "college") return "college";
  if (tags.amenity === "hospital" || tags.healthcare === "hospital") return "hospital";
  if (tags.amenity === "school") return "school";
  if (tags.railway === "station" || tags.public_transport === "station") return "station";
  if (tags.amenity === "library") return "library";
  if (tags.amenity === "place_of_worship") return "place of worship";
  if (tags.shop) return "shop";
  if (tags.amenity) return String(tags.amenity).replace(/_/g, " ");
  if (tags.tourism) return String(tags.tourism).replace(/_/g, " ");
  if (tags.leisure) return String(tags.leisure).replace(/_/g, " ");
  if (tags.building && tags.building !== "yes") return String(tags.building).replace(/_/g, " ");
  return "landmark";
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.places;
}

async function findNearbyPlaces(latitude, longitude, radiusMeters = 500) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) return [];
  const radius = Math.max(100, Math.min(1500, Number(radiusMeters) || 500));
  const key = lat.toFixed(3) + "," + lon.toFixed(3) + ":" + radius;
  const cached = cacheGet(key);
  if (cached) return cached.map(place => ({
    ...place,
    distanceKm: Number(distanceKm(lat, lon, place.latitude, place.longitude).toFixed(3))
  }));

  // Persist geographic discovery across restarts. Cache only public place metadata,
  // never the user's identity or their location-sharing history.
  try {
    const stored = await NearbyPlaceCache.findOne({
      cacheKey: key,
      fetchedAt: { $gt: new Date(Date.now() - CACHE_TTL_MS) }
    }).lean();
    if (stored && Array.isArray(stored.places)) {
      const places = stored.places.map(place => ({
        name: place.name,
        category: place.category || "landmark",
        roadType: place.roadType || null,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        distanceKm: Number(distanceKm(lat, lon, Number(place.latitude), Number(place.longitude)).toFixed(3)),
        source: place.source || "OpenStreetMap"
      })).filter(place => Number.isFinite(place.latitude) && Number.isFinite(place.longitude))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      cache.set(key, { savedAt: Date.now(), places });
      return places;
    }
  } catch (error) {
    console.warn("[Nearby places] Persistent cache read failed:", error.message);
  }

  // Public OSM Overpass is a fallback, not a high-volume map-tile service.
  // Cache results and throttle calls; do not request the whole map.
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const filters = [
    '["amenity"]', '["shop"]', '["office"]', '["tourism"]', '["leisure"]',
    '["railway"="station"]', '["public_transport"="station"]',
    '["university"]', '["college"]', '["school"]', '["healthcare"]',
    '["historic"]', '["place_of_worship"]', '["building"="university"]', '["highway"]'
  ];
  const clauses = filters.map(filter =>
    'nwr(around:' + radius + ',' + lat + ',' + lon + ')["name"]' + filter + ';'
  ).join("\n");
  const query = '[out:json][timeout:10];(\n' + clauses + '\n);out center tags 60;';
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  let payload = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "RevaLocationAssistant/1.0 (nearby named place lookup)"
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        console.warn("[Nearby places] Overpass returned HTTP", response.status);
        continue;
      }
      payload = await response.json();
      break;
    } catch (error) {
      console.warn("[Nearby places] Overpass lookup failed:", error.message);
    }
  }
  if (!payload || !Array.isArray(payload.elements)) return [];

  const seen = new Set();
  const places = payload.elements.map(element => {
    const tags = element.tags || {};
    const pointLat = Number(element.lat ?? element.center?.lat);
    const pointLon = Number(element.lon ?? element.center?.lon);
    const name = tags["name:en"] || tags.name;
    if (!name || !Number.isFinite(pointLat) || !Number.isFinite(pointLon)) return null;
    const identity = String(name).toLocaleLowerCase("en-IN") + ":" + pointLat.toFixed(5) + ":" + pointLon.toFixed(5);
    if (seen.has(identity)) return null;
    seen.add(identity);
    return {
      name: String(name),
      category: classify(tags),
      roadType: tags.highway ? String(tags.highway) : null,
      latitude: pointLat,
      longitude: pointLon,
      distanceKm: Number(distanceKm(lat, lon, pointLat, pointLon).toFixed(3)),
      source: "OpenStreetMap"
    };
  }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm);

  // Preserve nearby institutions in addition to the nearest generic POIs. In a
  // dense city, a strict nearest-25 cutoff can otherwise drop the campus being asked about.
  const priorityLandmarks = places
    .filter(place => ["university", "college", "school", "hospital", "station"].includes(place.category))
    .slice(0, 15);
  const selected = new Map();
  for (const place of [...priorityLandmarks, ...places.slice(0, 25)]) {
    selected.set(place.name.toLocaleLowerCase("en-IN") + ":" + place.latitude.toFixed(5) + ":" + place.longitude.toFixed(5), place);
  }
  const results = [...selected.values()].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 35);

  cache.set(key, { savedAt: Date.now(), places: results });
  try {
    await NearbyPlaceCache.updateOne(
      { cacheKey: key },
      {
        $set: {
          cacheKey: key,
          latitude: lat,
          longitude: lon,
          radiusMeters: radius,
          places: results.map(place => ({
            name: place.name,
            normalizedName: place.name.toLocaleLowerCase("en-IN").replace(/\s+/g, " ").trim(),
            category: place.category,
            roadType: place.roadType || null,
            latitude: place.latitude,
            longitude: place.longitude,
            source: place.source
          })),
          fetchedAt: new Date()
        }
      },
      { upsert: true, runValidators: true }
    );
  } catch (error) {
    console.warn("[Nearby places] Persistent cache write failed:", error.message);
  }
  if (cache.size > 500) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  return results;
}

module.exports = { findNearbyPlaces };
