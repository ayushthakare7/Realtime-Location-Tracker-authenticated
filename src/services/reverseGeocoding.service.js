// Reverse geocoding with persistent and in-memory caching.
const ReverseGeocodeCache = require("../models/ReverseGeocodeCache");
const geocodeCache = new Map();
let lastGeocodeAt = 0;

async function reverseGeocode(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const fallback = {
    placeName: `Location near ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    city: null, state: null, country: null, countryCode: null
  };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
      !Number.isFinite(lon) || lon < -180 || lon > 180) return fallback;
  if (process.env.GEOCODING_ENABLED === "false") return fallback;

  // Round to roughly city-block scale and persist successful lookups across
  // process restarts. Never cache a coordinate-only failure as a named place.
  const cacheKey = lat.toFixed(3) + "," + lon.toFixed(3);
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  try {
    const cached = await ReverseGeocodeCache.findOne({
      cacheKey, fetchedAt: { $gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
    }).lean();
    if (cached) {
      const result = {
        placeName: cached.placeName, road: cached.road || null, locality: cached.locality || null,
        city: cached.city || null, state: cached.state || null, country: cached.country || null,
        countryCode: cached.countryCode || null
      };
      geocodeCache.set(cacheKey, result);
      return result;
    }
  } catch (error) {
    console.warn("[Geocoding] Persistent cache read failed:", error.message);
  }

  // Nominatim's public endpoint is rate-limited; request it once per lookup,
  // then fall back to broader zoom levels only if the response has no usable label.
  for (const zoom of [18, 14, 10]) {
    try {
      const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastGeocodeAt = Date.now();
      const url = new URL("https://nominatim.openstreetmap.org/reverse");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      url.searchParams.set("zoom", String(zoom));
      url.searchParams.set("addressdetails", "1");
      const response = await fetch(url, {
        headers: { "User-Agent": "RevaLocationAssistant/1.0 (location labels)" },
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        console.warn("[Geocoding] Nominatim HTTP", response.status, "at zoom", zoom);
        continue;
      }
      const data = await response.json();
      const address = data.address || {};
      const road = address.road || address.pedestrian || address.footway || address.residential || null;
      const locality = address.neighbourhood || address.suburb || address.quarter || address.hamlet || address.village || address.city_district || null;
      const city = address.city || address.town || address.municipality || address.village ||
        address.city_district || address.suburb || address.neighbourhood || null;
      const state = address.state || address.state_district || address.county || null;
      const country = address.country || null;
      const countryCode = address.country_code || null;
      const feature = data.name || address.amenity || address.university || address.college ||
        address.school || address.hospital || address.building || address.road ||
        address.neighbourhood || address.suburb || null;
      const placeName = feature || city || state || country;
      if (!placeName && !city && !state && !country) continue;
      const result = {
        placeName: String(placeName || fallback.placeName).slice(0, 160),
        road: road ? String(road).slice(0, 160) : null,
        locality: locality ? String(locality).slice(0, 160) : null,
        city: city ? String(city) : null,
        state: state ? String(state) : null,
        country: country ? String(country) : null,
        countryCode: countryCode ? String(countryCode).toUpperCase() : null
      };
      geocodeCache.set(cacheKey, result);
      if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value);
      try {
        await ReverseGeocodeCache.updateOne(
          { cacheKey },
          { $set: { cacheKey, latitude: lat, longitude: lon, ...result, fetchedAt: new Date() } },
          { upsert: true }
        );
      } catch (error) {
        console.warn("[Geocoding] Persistent cache write failed:", error.message);
      }
      return result;
    } catch (error) {
      console.warn("[Geocoding] Reverse lookup failed at zoom " + zoom + ":", error.message);
    }
  }
  // Provider fallback: BigDataCloud's client reverse-geocoder often resolves
  // locality/municipality even when Nominatim is throttled or has no detailed POI.
  // This is still a best-effort label, not proof of a specific building.
  try {
    const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("localityLanguage", "en");
    const response = await fetch(url, {
      headers: { "User-Agent": "RevaLocationAssistant/1.0 (location labels)" },
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) {
      const data = await response.json();
      const city = data.city || data.locality || data.localityInfo?.administrative?.find(
        item => /city|town|municipality|district/i.test(String(item.description || item.name || ""))
      )?.name || null;
      const state = data.principalSubdivision || data.principalSubdivisionCode || null;
      const country = data.countryName || null;
      const feature = data.locality || data.city || null;
      if (feature || city || state || country) {
        const result = {
          placeName: String(feature || city || state || country).slice(0, 160),
          road: null,
          locality: data.locality ? String(data.locality).slice(0, 160) : null,
          city: city ? String(city) : null,
          state: state ? String(state) : null,
          country: country ? String(country) : null,
          countryCode: data.countryCode ? String(data.countryCode).toUpperCase() : null
        };
        geocodeCache.set(cacheKey, result);
        if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value);
        try {
          await ReverseGeocodeCache.updateOne(
            { cacheKey },
            { $set: { cacheKey, latitude: lat, longitude: lon, ...result, fetchedAt: new Date() } },
            { upsert: true }
          );
        } catch (error) {
          console.warn("[Geocoding] Persistent fallback cache write failed:", error.message);
        }
        return result;
      }
    } else {
      console.warn("[Geocoding] BigDataCloud fallback HTTP", response.status);
    }
  } catch (error) {
    console.warn("[Geocoding] BigDataCloud fallback failed:", error.message);
  }

  // Do not memoize failure: a later request may succeed after provider recovery.
  return fallback;
}

module.exports = { reverseGeocode };
