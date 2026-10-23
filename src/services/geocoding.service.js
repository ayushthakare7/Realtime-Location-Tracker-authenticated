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

const COUNTRY_ALIASES = [
  { aliases: ["india"], country: "india", code: "in" },
  { aliases: ["united states", "usa", "america", "us"], country: "united states", code: "us" },
  { aliases: ["united kingdom", "great britain", "britain", "uk"], country: "united kingdom", code: "gb" },
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
  { aliases: ["sri lanka", "srilanka"], country: "sri lanka", code: "lk" }
];

function detectCountry(query) {
  const normalized = normalizeQuery(query);
  for (const entry of COUNTRY_ALIASES) {
    for (const alias of entry.aliases) {
      // Whole-word matching prevents "us" from matching the username "user2".
      const pattern = "(^|[^a-z])" + alias.split(" ").join("\\s+") + "([^a-z]|$)";
      if (new RegExp(pattern, "i").test(normalized)) {
        return { ...entry, matchedAlias: alias };
      }
    }
  }
  return null;
}

function removeCountry(query, countryMatch) {
  if (!countryMatch) return String(query || "").trim();
  const pattern = "(^|[^a-z])" + countryMatch.matchedAlias.split(" ").join("\\s+") + "([^a-z]|$)";
  return String(query || "").replace(new RegExp(pattern, "i"), " ").replace(/[,;\s]+/g, " ").trim();
}

function placeMatches(item, placeQuery, countryMatch) {
  const address = item.address || {};
  const settlement = normalizeQuery(
    address.city || address.town || address.village || address.municipality ||
    address.hamlet || item.name || ""
  );
  const searchable = normalizeQuery([
    settlement, item.name, item.display_name, address.state, address.country
  ].filter(Boolean).join(" "));
  const tokens = normalizeQuery(placeQuery).split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every(token => searchable.includes(token))) return false;
  if (countryMatch && normalizeQuery(address.country) !== countryMatch.country) return false;
  return true;
}

/**
 * Resolve a place globally with OpenStreetMap Nominatim. An explicitly named
 * country constrains the lookup; unrelated provider results are rejected.
 */
async function geocodePlace(input) {
  const query = String(input || "").trim();
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return null;

  const countryMatch = detectCountry(query);
  const isCountryOnly = Boolean(countryMatch && countryMatch.aliases.some(
    alias => normalizeQuery(alias) === normalizedQuery
  ));
  const placeQuery = isCountryOnly
    ? countryMatch.country
    : (removeCountry(query, countryMatch) || query);

  // Validate cache entries too; older versions may have cached a wrong place.
  const cached = await GeocodedPlace.findOne({ normalizedQuery }).lean();
  if (cached) {
    const cachedName = normalizeQuery(cached.name);
    const requestedName = normalizeQuery(placeQuery);
    const nameMatches = requestedName && requestedName.split(/\s+/).every(token => cachedName.includes(token));
    const countryMatches = !countryMatch || normalizeQuery(cached.country) === countryMatch.country;
    if (nameMatches && countryMatches) return asPlace(cached);
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", placeQuery);
  if (countryMatch) url.searchParams.set("countrycodes", countryMatch.code);
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "10");

  const response = await fetch(url, {
    headers: { "User-Agent": "PrivacyAwareLocationTracker/1.0 (place geocoding)" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Geocoding provider returned HTTP " + response.status);

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  const matching = results.filter(item => placeMatches(item, placeQuery, countryMatch));
  const result = matching.find(item => {
    const address = item.address || {};
    const settlement = address.city || address.town || address.village ||
      address.municipality || address.hamlet || item.name;
    return normalizeQuery(settlement) === normalizeQuery(placeQuery);
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
      address.municipality || address.hamlet || result.name || placeQuery,
    state: address.state || null,
    country: address.country ? normalizeQuery(address.country) : null,
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
    if (error.code !== 11000) console.warn("[Geocoding] Cache write failed:", error.message);
  }

  return asPlace(record);
}

module.exports = { geocodePlace };
