const PROFILES = new Set(["driving-car", "cycling-regular", "motorbike", "foot-walking", "bus", "train"]);
const ROUTING_PROFILE = { motorbike: "driving-car", bus: "driving-car", train: "driving-car" };
const routeCache = new Map();
const geocodeCache = new Map();
const RoutingUsage = require("../models/RoutingUsage");

async function reserveRequest(kind) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const limit = kind === "directions"
    ? Math.max(1, Number(process.env.MOBILITY_MAX_DIRECTIONS_PER_DAY) || 1500)
    : Math.max(1, Number(process.env.MOBILITY_MAX_GEOCODE_PER_DAY) || 500);
  const current = await RoutingUsage.findOne({ dayKey, kind }).lean();
  if (current && current.requests >= limit) {
    const error = new Error("Reva reached its configured daily free-tier " + kind + " budget. Try again tomorrow or lower usage by reusing a recent route.");
    error.status = 429;
    throw error;
  }
  await RoutingUsage.findOneAndUpdate(
    { dayKey, kind },
    { $inc: { requests: 1 }, $setOnInsert: { dayKey, kind } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}
function cacheRead(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return item.value;
}
function cacheWrite(cache, key, value, ttlMs) {
  if (cache.size >= 400) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function routeBetween(origin, destination, profile) {
  if (!process.env.ORS_API_KEY) {
    const error = new Error("Road routing is not configured. Add a free OpenRouteService API key to the mobility service.");
    error.status = 503;
    throw error;
  }
  if (!PROFILES.has(profile)) {
    const error = new Error("Unsupported transport mode.");
    error.status = 400;
    throw error;
  }

  const requestedMode = profile;
  const routingProfile = ROUTING_PROFILE[requestedMode] || requestedMode;
  const cacheKey = [routingProfile, origin.latitude.toFixed(5), origin.longitude.toFixed(5), destination.latitude.toFixed(5), destination.longitude.toFixed(5)].join(":");
  const cached = cacheRead(routeCache, cacheKey);
  if (cached) return cached;
  await reserveRequest("directions");
  const response = await fetch("https://api.openrouteservice.org/v2/directions/" + routingProfile + "/geojson", {
    method: "POST",
    headers: {
      Authorization: process.env.ORS_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/geo+json"
    },
    body: JSON.stringify({
      coordinates: [
        [origin.longitude, origin.latitude],
        [destination.longitude, destination.latitude]
      ],
      instructions: false,
      elevation: false
    }),
    signal: AbortSignal.timeout(12000)
  });

  if (response.status === 429) {
    const error = new Error("The free road-routing quota is temporarily exhausted. Please try again later.");
    error.status = 429;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403
      ? "The routing API key is invalid or does not have access to this route."
      : "The road route could not be calculated right now.");
    error.status = response.status === 400 ? 400 : 502;
    throw error;
  }

  const data = await response.json();
  const feature = data.features && data.features[0];
  const summary = feature && feature.properties && feature.properties.summary;
  const coordinates = feature && feature.geometry && feature.geometry.coordinates;
  if (!summary || !Array.isArray(coordinates) || coordinates.length < 2) {
    const error = new Error("The routing provider returned no usable road route.");
    error.status = 502;
    throw error;
  }

  const result = {
    provider: "openrouteservice",
    profile: routingProfile,
    transportMode: requestedMode,
    estimateType: ROUTING_PROFILE[requestedMode] ? "road-network-approximation" : "profile-route",
    distanceMeters: Math.round(summary.distance),
    durationSeconds: Math.round(summary.duration),
    coordinates,
    calculatedAt: new Date()
  };
  cacheWrite(routeCache, cacheKey, result, 2 * 60 * 1000);
  return result;
}

async function geocode(query) {
  if (!process.env.ORS_API_KEY) {
    const error = new Error("Destination search is not configured. Add a free OpenRouteService API key to the mobility service.");
    error.status = 503;
    throw error;
  }
  const cacheKey = query.toLowerCase().replace(/\s+/g, " ");
  const cached = cacheRead(geocodeCache, cacheKey);
  if (cached) return cached;
  await reserveRequest("geocode");
  const url = new URL("https://api.openrouteservice.org/geocode/search");
  const airportQuery = /\braipur\b/i.test(query) && /airport|air port|swami vivekananda/i.test(query)
    ? "Swami Vivekananda Airport, Raipur, Chhattisgarh, India"
    : query;
  url.searchParams.set("text", airportQuery);
  url.searchParams.set("size", "10");
  url.searchParams.set("layers", "venue,address,street,locality,county,region");
  const response = await fetch(url, {
    headers: { Authorization: process.env.ORS_API_KEY },
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 429) {
    const error = new Error("The free geocoding quota is temporarily exhausted.");
    error.status = 429;
    throw error;
  }
  if (!response.ok) {
    const error = new Error("Destination search is temporarily unavailable.");
    error.status = 502;
    throw error;
  }
  const data = await response.json();
  const wantsRaipurAirport = /\braipur\b/i.test(query) && /airport|air port|swami vivekananda|mana/i.test(query);
  const results = (data.features || []).map(feature => {
    const p = feature.properties || {};
    const c = feature.geometry && feature.geometry.coordinates || [];
    return {
      label: p.label || p.name || query,
      latitude: Number(c[1]),
      longitude: Number(c[0])
    };
  }).filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  if (wantsRaipurAirport) {
    results.sort((a, b) => {
      const score = label => /swami vivekananda|raipur airport|mana airport/i.test(label) ? 0
        : /airport|air port/i.test(label) ? 1
        : /raipur/i.test(label) ? 2 : 3;
      return score(a.label) - score(b.label);
    });
  }
  cacheWrite(geocodeCache, cacheKey, results, 10 * 60 * 1000);
  return results;
}

module.exports = { routeBetween, geocode };
