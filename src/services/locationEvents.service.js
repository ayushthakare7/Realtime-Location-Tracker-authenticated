const LocationVisit = require("../models/LocationVisit");
const LocationEvent = require("../models/LocationEvent");
const ReverseGeocodeCache = require("../models/ReverseGeocodeCache");
const { indexLocationEvent } = require("./ragClient.service");

const VISIT_RADIUS_METERS = Number(process.env.VISIT_RADIUS_METERS) || 150;
const MIN_STAY_MINUTES = Number(process.env.MIN_STAY_MINUTES) || 15;
const geocodeCache = new Map();
let lastGeocodeAt = 0;

function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
        placeName: cached.placeName, city: cached.city || null,
        state: cached.state || null, country: cached.country || null,
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
  // Do not memoize failure: a later request may succeed after provider recovery.
  return fallback;
}

async function placeLabel(latitude, longitude) {
  const result = await reverseGeocode(latitude, longitude);
  return result.placeName;
}

function eventText(event) {
  return [
    `Person: ${event.username}`,
    `Event: ${event.eventType}`,
    `Place: ${event.placeName}`,
    `Summary: ${event.summary}`,
    `Started: ${new Date(event.startAt).toISOString()}`,
    `Ended: ${new Date(event.endAt).toISOString()}`,
    `Duration minutes: ${event.durationMinutes || 0}`
  ].join(". ");
}

async function saveEvent({ userId, username, eventType, placeName, latitude, longitude, startAt, endAt, recordedAt, durationMinutes, eventKey }) {
  const duration = Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : undefined;
  const summary = eventType === "arrival"
    ? `${username} arrived at ${placeName} at ${new Date(startAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}.`
    : eventType === "departure"
      ? `${username} left ${placeName} at ${new Date(recordedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} after approximately ${duration || 0} minutes.`
      : `${username} stayed at ${placeName} for approximately ${duration || 0} minutes.`;

  const event = await LocationEvent.findOneAndUpdate(
    { eventKey },
    { $set: { userId, username, eventType, placeName, latitude, longitude, startAt, endAt, recordedAt, durationMinutes: duration, summary, eventKey } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  // Index asynchronously: a temporary Python outage must not block location tracking.
  void indexLocationEvent(event._id).catch(error => {
    console.error("Python RAG event indexing failed:", error.message);
  });
  return event;
}

async function startVisit(userId, username, latitude, longitude, at) {
  const placeName = await placeLabel(latitude, longitude);
  const visit = await LocationVisit.findOneAndUpdate(
    { userId },
    { $set: { userId, username, latitude, longitude, placeName, startedAt: at, lastSeen: at, pointCount: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await saveEvent({ userId, username, eventType: "arrival", placeName, latitude, longitude, startAt: at, endAt: at, recordedAt: at, durationMinutes: 0, eventKey: `visit:${userId}:${new Date(at).getTime()}:arrival` });
  return visit;
}

async function processLocationEvent({ userId, username, latitude, longitude, recordedAt = new Date() }) {
  const at = new Date(recordedAt);
  let visit = await LocationVisit.findOne({ userId }).lean();
  if (!visit) {
    await startVisit(userId, username, latitude, longitude, at);
    return;
  }
  const gapMinutes = (at.getTime() - new Date(visit.lastSeen).getTime()) / 60000;
  const meters = distanceMeters(visit.latitude, visit.longitude, latitude, longitude);
  const sameVisit = meters <= VISIT_RADIUS_METERS && gapMinutes >= 0 && gapMinutes <= 30;
  if (sameVisit) {
    visit = await LocationVisit.findOneAndUpdate({ userId }, { $set: { username, lastSeen: at }, $inc: { pointCount: 1 } }, { new: true }).lean();
    const durationMinutes = (at.getTime() - new Date(visit.startedAt).getTime()) / 60000;
    if (durationMinutes >= MIN_STAY_MINUTES) await saveEvent({ userId, username, eventType: "stay", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: at, recordedAt: at, durationMinutes, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:stay` });
    return;
  }
  const previousDuration = (new Date(visit.lastSeen).getTime() - new Date(visit.startedAt).getTime()) / 60000;
  if (previousDuration >= MIN_STAY_MINUTES) await saveEvent({ userId, username: visit.username, eventType: "stay", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: visit.lastSeen, recordedAt: visit.lastSeen, durationMinutes: previousDuration, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:stay` });
  await saveEvent({ userId, username: visit.username, eventType: "departure", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: visit.lastSeen, recordedAt: at, durationMinutes: previousDuration, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:departure` });
  await startVisit(userId, username, latitude, longitude, at);
}

module.exports = { processLocationEvent, distanceMeters, placeLabel, reverseGeocode };
