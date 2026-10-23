const GeocodedPlace = require("../models/GeocodedPlace");

function normalizeQuery(value) {
  return String(value || "").trim().toLocaleLowerCase("en-IN").replace(/\s+/g, " ");
}

function asPlace(record) {
  return {
    latitude: Number(record.latitude),
    longitude: Number(record.longitude),
    name: record.name,
    state: record.state || null,
    country: record.country || null
  };
}

/**
 * Resolve a place anywhere in the world through OpenStreetMap Nominatim.
 * Successful lookups are cached in MongoDB to reduce repeat requests.
 */
async function geocodePlace(input) {
  const query = String(input || "").trim();
  // Normalize common country aliases so Nominatim gets an unambiguous global query.
  let searchQuery = query
    .replace(/\bU\.S\.A\.?\b/ig, "United States")
    .replace(/\bUSA\b/ig, "United States")
    .replace(/\bU\.S\.?\b/ig, "United States")
    .replace(/\bUK\b/ig, "United Kingdom");
  if (/^(america|usa|u\.s\.a\.?|us)$/i.test(query)) {
    searchQuery = "United States of America";
  }
  // Version the cache key so old India-only cached coordinates cannot be reused.
  const normalizedQuery = "world-v2:" + normalizeQuery(searchQuery);
  if (!normalizedQuery) return null;

  const cached = await GeocodedPlace.findOne({ normalizedQuery }).lean();
  if (cached) return asPlace(cached);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "PrivacyAwareLocationTracker/1.0 (place geocoding)"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error("Geocoding provider returned HTTP " + response.status);
  }

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  // Prefer exact settlement or country matches, then use Nominatim's ranked result.
  const result = results.find(item => {
    const address = item.address || {};
    const settlement = address.city || address.town || address.village ||
      address.municipality || address.hamlet || address.country;
    return settlement && normalizeQuery(settlement) === normalizeQuery(searchQuery);
  }) || results[0];

  if (!result) return null;

  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
    !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    throw new Error("Geocoding provider returned invalid coordinates");
  }

  const address = result.address || {};
  const record = {
    normalizedQuery,
    query,
    name: address.city || address.town || address.village ||
      address.municipality || address.hamlet || result.name || query,
    state: address.state || null,
    country: address.country || null,
    latitude,
    longitude,
    provider: "nominatim",
    providerPlaceId: result.place_id == null ? null : String(result.place_id),
    fetchedAt: new Date()
  };

  try {
    await GeocodedPlace.updateOne(
      { normalizedQuery },
      { $set: record },
      { upsert: true, runValidators: true }
    );
  } catch (error) {
    // Concurrent requests can race on the unique normalizedQuery index.
    if (error.code !== 11000) console.warn("[Geocoding] Cache write failed:", error.message);
  }

  return asPlace(record);
}

module.exports = { geocodePlace };
