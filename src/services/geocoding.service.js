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

  // Never blindly accept Nominatim's first result: ambiguous queries such as
  // "Nagpur INDIA" can otherwise resolve to an unrelated island or region.
  const countryWords = new Set([
    "india", "united", "states", "state", "america", "american", "usa", "us",
    "kingdom", "uk", "britain", "great", "britain", "canada", "australia",
    "malaysia", "singapore", "indonesia", "thailand", "japan", "china",
    "france", "germany", "italy", "spain", "brazil", "mexico", "russia",
    "uae", "emirates", "saudi", "arabia", "pakistan", "nepal", "sri", "lanka"
  ]);
  const queryTokens = normalizeQuery(query)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const placeTokens = queryTokens.filter(token => !countryWords.has(token));
  const requiredTokens = placeTokens.length ? placeTokens : queryTokens;
  const countryAliases = [
    { variants: [["india"]], country: "india" },
    { variants: [["america"], ["american"], ["usa"], ["us"], ["united", "states"]], country: "united states" },
    { variants: [["uk"], ["britain"], ["great", "britain"], ["united", "kingdom"]], country: "united kingdom" },
    { variants: [["canada"]], country: "canada" },
    { variants: [["australia"]], country: "australia" },
    { variants: [["malaysia"]], country: "malaysia" },
    { variants: [["singapore"]], country: "singapore" },
    { variants: [["indonesia"]], country: "indonesia" },
    { variants: [["thailand"]], country: "thailand" },
    { variants: [["japan"]], country: "japan" },
    { variants: [["china"]], country: "china" },
    { variants: [["france"]], country: "france" },
    { variants: [["germany"]], country: "germany" },
    { variants: [["italy"]], country: "italy" },
    { variants: [["spain"]], country: "spain" },
    { variants: [["brazil"]], country: "brazil" },
    { variants: [["mexico"]], country: "mexico" },
    { variants: [["russia"]], country: "russia" },
    { variants: [["pakistan"]], country: "pakistan" },
    { variants: [["nepal"]], country: "nepal" },
    { variants: [["sri", "lanka"]], country: "sri lanka" }
  ];
  const expectedCountry = countryAliases.find(entry =>
    entry.variants.some(variant => variant.every(token => queryTokens.includes(token)))
  )?.country || null;
  const resultText = item => {
    const address = item.address || {};
    return normalizeQuery([
      item.name, item.display_name, address.city, address.town, address.village,
      address.municipality, address.county, address.state, address.country
    ].filter(Boolean).join(" "));
  };
  const relevant = results.filter(item => {
    const text = resultText(item);
    const country = normalizeQuery(item.address?.country || "");
    return requiredTokens.every(token => text.includes(token)) &&
      (!expectedCountry || country === expectedCountry);
  });
  if (!relevant.length) {
    console.warn("[Geocoding] Refusing unrelated result for query:", query);
    return null;
  }
  const result = relevant.find(item => {
    const address = item.address || {};
    const settlement = address.city || address.town || address.village ||
      address.municipality || address.hamlet || address.country || item.name;
    return settlement && normalizeQuery(settlement) === normalizeQuery(query);
  }) || relevant[0];

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
