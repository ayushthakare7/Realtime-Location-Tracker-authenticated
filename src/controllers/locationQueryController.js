const Location = require("../models/Location");
const { askMap } = require("./trackerController");

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractCityDistanceTarget(question) {
  const match = String(question || "").match(/\b(?:how\s+many\s*(?:km|kilometers?|kilometres?|miles?)|how\s+far|distance)\s+(?:is\s+)?(.+?)\s+(?:away\s+from\s+me|from\s+me|away)\b/i);
  if (!match) return null;
  const target = match[1]
    .replace(/^is\s+/i, "")
    .replace(/\b(?:the|city)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!target || target.length > 80) return null;
  return target;
}

async function geocodeCity(city) {
  if (process.env.GEOCODING_ENABLED !== "true") return null;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("q", `${city}, India`);
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  const response = await fetch(url, {
    headers: { "User-Agent": "PrivacyAwareLocationTracker/1.0" },
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return null;
  const results = await response.json();
  if (!Array.isArray(results) || !results.length) return null;
  const result = results[0];
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    latitude: lat,
    longitude: lon,
    name: result.address?.city || result.address?.town || result.address?.municipality || city,
    state: result.address?.state || null,
    country: result.address?.country || "India"
  };
}

exports.ask = async (req, res) => {
  const question = String(req.body.question || "").trim();
  const targetCity = extractCityDistanceTarget(question);

  if (!targetCity) return askMap(req, res);

  try {
    const mine = await Location.findOne({ userId: req.user.userId }).lean();
    if (!mine) {
      return res.json({
        success: true,
        answer: "I need your latest location first. Turn on location sharing and allow location access, then ask me again."
      });
    }

    const destination = await geocodeCity(targetCity);
    if (!destination) return askMap(req, res);

    const km = distanceKm(mine.latitude, mine.longitude, destination.latitude, destination.longitude);
    const meters = Math.round(km * 1000);
    const displayName = destination.name || targetCity;
    const state = destination.state ? `, ${destination.state}` : "";

    return res.json({
      success: true,
      answer: `${displayName}${state} is approximately ${meters.toLocaleString("en-IN")} metres (${km.toFixed(2)} km) from your current location in a straight line. This is geographic distance, not road distance.`
    });
  } catch (error) {
    console.error("City distance query failed:", error.message);
    return askMap(req, res);
  }
};
