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
  // Older versions could cache an unrelated provider result under this query.
  // Reuse a cache entry only when its resolved place still matches the query.
  if (cached) {
    const cachedName = normalizeQuery(cached.name);
    const requestedPlace = normalizeQuery(
      query.replace(/\b(india|usa|america|united states|uk|united kingdom|canada|australia|malaysia|singapore|indonesia|thailand|japan|china|france|germany|italy|spain|brazil|mexico|russia|pakistan|nepal|sri lanka)\b/ig, "").replace(/[,\s]+/g, " ").trim()
    );
    if (requestedPlace && (cachedName === requestedPlace || cachedName.includes(requestedPlace) || requestedPlace.includes(cachedName))) {
      if (!countryMatch || normalizeQuery(cached.country) === countryMatch.country) return asPlace(cached);
    }
  }

  // Detect an explicit country in the user's query; otherwise search globally.
  const countryAliases = [
    { aliases: ["india"], country: "india", code: "in" },
    { aliases: ["united states"], country: "united states", code: "us" },
    { aliases: ["usa"], country: "united states", code: "us" },
    { aliases: ["america"], country: "united states", code: "us" },
    { aliases: ["united kingdom"], country: "united kingdom", code: "gb" },
    { aliases: ["uk"], country: "united kingdom", code: "gb" },
    { aliases: ["canada"], country: "canada", code: "ca" },
    { aliases: ["australia"], country: "australia", code: "au" },
    { aliases: ["malaysia"], country: "malaysia", code: "my" },
    { aliases: ["singapore"], country: "singapore", code: "sg" },
    { aliases: ["indonesia"], country: "indonesia", code: "id" },
    { aliases: ["thailand"], country: "thailand", code: "th" },
    { aliases: ["japan"], country: "japan", code: "jp" },
    { aliases: ["china"], country: "china", code: "cn" },
    { aliases: ["france"], country: "france", code: "fr" },
    { aliases: ["germany"], country: "germany", code: "de" },
    { aliases: ["italy"], country: "italy", code: "it" },
    { aliases: ["spain"], country: "spain", code: "es" },
    { aliases: ["brazil"], country: "brazil", code: "br" },
    { aliases: ["mexico"], country: "mexico", code: "mx" },
    { aliases: ["russia"], country: "russia", code: "ru" },
    { aliases: ["pakistan"], country: "pakistan", code: "pk" },
    { aliases: ["nepal"], country: "nepal", code: "np" },
    { aliases: ["sri lanka"], country: "sri lanka", code: "lk" }
  ];
  const normalizedInput = normalizeQuery(query);
  const countryMatch = countryAliases.find(entry =>
    entry.aliases.some(alias => normalizedInput.includes(alias))
  ) || null;
  const placeQuery = countryMatch
    ? query.replace(new RegExp(countryMatch.aliases[0].replace(/[.*+?^${}()|[\]\\]/g, "\\  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", query + ", India");
  url.searchParams.set("countrycodes", "in");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "5");"), "i"), "").replace(/[,\s]+$/g, "").trim()
    : query;
  const searchQuery = placeQuery || query;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", searchQuery);
  if (countryMatch) url.searchParams.set("countrycodes", countryMatch.code);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "10");

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

  // Reject unrelated search results instead of silently calculating a distance
  // to a different island/region when the provider's top result is a poor match.
  const requestedPlace = normalizeQuery(searchQuery)
    .replace(/\b(india|usa|america|united states|uk|united kingdom|canada|australia|malaysia|singapore|indonesia|thailand|japan|china|france|germany|italy|spain|brazil|mexico|russia|pakistan|nepal|sri lanka)\b/ig, "")
    .replace(/[,\s]+/g, " ").trim();
  const tokens = requestedPlace.split(/\s+/).filter(Boolean);
  const matching = results.filter(item => {
    const address = item.address || {};
    const country = normalizeQuery(address.country || "");
    const settlement = normalizeQuery(
      address.city || address.town || address.village || address.municipality ||
      address.hamlet || address.county || item.name || ""
    );
    const searchable = normalizeQuery([settlement, item.name, item.display_name, address.state].filter(Boolean).join(" "));
    const tokenMatch = tokens.length > 0 && tokens.every(token => searchable.includes(token));
    const countryMatchOk = !countryMatch || country === countryMatch.country;
    return tokenMatch && countryMatchOk;
  });
  const result = matching.find(item => {
    const address = item.address || {};
    const settlement = address.city || address.town || address.village ||
      address.municipality || address.hamlet || item.name;
    return normalizeQuery(settlement) === requestedPlace;
  }) || matching[0];

  if (!result) {
    console.warn("[Geocoding] No relevant result for place query:", query);
    return null;
  }

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
      address.municipality || address.hamlet || result.name || searchQuery,
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
