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
  if (cached) return cached;

  // Public OSM Overpass is a fallback, not a high-volume map-tile service.
  // Cache results and throttle calls; do not request the whole map.
  const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const filters = [
    '["amenity"]', '["shop"]', '["office"]', '["tourism"]', '["leisure"]',
    '["railway"="station"]', '["public_transport"="station"]',
    '["university"]', '["college"]', '["school"]', '["healthcare"]',
    '["historic"]', '["place_of_worship"]', '["building"="university"]'
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
      latitude: pointLat,
      longitude: pointLon,
      distanceKm: Number(distanceKm(lat, lon, pointLat, pointLon).toFixed(3)),
      source: "OpenStreetMap"
    };
  }).filter(Boolean).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 8);

  cache.set(key, { savedAt: Date.now(), places });
  if (cache.size > 500) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  return places;
}

module.exports = { findNearbyPlaces };
