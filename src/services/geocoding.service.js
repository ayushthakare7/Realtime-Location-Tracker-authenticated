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
    country: record.country || "India"
  };
}

/**
 * Resolve any Indian city/town/village/place through OpenStreetMap Nominatim.
 * Successful lookups are cached in MongoDB to reduce repeat requests and
 * avoid relying on a hardcoded list of cities.
 */
async function geocodePlace(input) {
  const query = String(input || "").trim();
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return null;

  const cached = await GeocodedPlace.findOne({ normalizedQuery }).lean();
  if (cached) return asPlace(cached);

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query + ", India");
  url.searchParams.set("countrycodes", "in");
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

  // Prefer settlement matches for city/town/village names; otherwise use the
  // provider's highest-ranked result. Country restriction is also checked.
  const result = results.find(item => {
    const address = item.address || {};
    const settlement = address.city || address.town || address.village ||
      address.municipality || address.hamlet;
    return settlement && normalizeQuery(settlement) === normalizedQuery &&
      (!address.country_code || address.country_code.toLowerCase() === "in");
  }) || results.find(item =>
    !item.address?.country_code || item.address.country_code.toLowerCase() === "in"
  );

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
    country: address.country || "India",
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
