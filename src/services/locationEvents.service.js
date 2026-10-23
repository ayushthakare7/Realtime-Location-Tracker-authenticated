const LocationVisit = require("../models/LocationVisit");
const LocationEvent = require("../models/LocationEvent");
const { embedText, EMBEDDING_MODEL } = require("./embedding.service");

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

async function placeLabel(latitude, longitude) {
  const fallback = `Location near ${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
  if (process.env.GEOCODING_ENABLED !== "true") return fallback;
  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);
  try {
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastGeocodeAt = Date.now();
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", "16");
    const response = await fetch(url, { headers: { "User-Agent": "PrivacyAwareLocationTracker/1.0" }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return fallback;
    const data = await response.json();
    const address = data.address || {};
    const label = address.amenity || address.building || address.university || address.suburb || address.neighbourhood || address.road || address.town || address.city || address.village || data.name;
    const result = label ? String(label).slice(0, 160) : fallback;
    geocodeCache.set(cacheKey, result);
    if (geocodeCache.size > 1000) geocodeCache.delete(geocodeCache.keys().next().value);
    return result;
  } catch { return fallback; }
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

async function indexEvent(event) {
  try {
    const embedding = await embedText(eventText(event));
    await LocationEvent.updateOne(
      { _id: event._id },
      { $set: { embedding, embeddingModel: EMBEDDING_MODEL, embeddingUpdatedAt: new Date() } }
    );
  } catch (error) {
    console.error("Location event embedding failed:", error.message);
  }
}

async function saveEvent({ userId, username, eventType, placeName, latitude, longitude, startAt, endAt, recordedAt, durationMinutes, eventKey }) {
  const duration = Number.isFinite(durationMinutes) ? Math.max(0, Math.round(durationMinutes)) : undefined;
  const summary = eventType === "arrival"
    ? `${username} arrived at ${placeName} at ${new Date(startAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}.`
    : eventType === "departure"
      ? `${username} left ${placeName} at ${new Date(recordedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })} after approximately ${duration || 0} minutes.`
      : `${username} stayed at ${placeName} for approximately ${duration || 0} minutes.`;

  const previous = await LocationEvent.findOne({ eventKey }).select("summary durationMinutes placeName embedding").lean();
  const event = await LocationEvent.findOneAndUpdate(
    { eventKey },
    { $set: { userId, username, eventType, placeName, latitude, longitude, startAt, endAt, recordedAt, durationMinutes: duration, summary, eventKey } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Do not embed every GPS update. Arrival/departure are embedded once; stay events are re-embedded
  // only when the semantic duration changes by at least 15 minutes.
  const durationDelta = Math.abs((duration || 0) - (previous?.durationMinutes || 0));
  const needsEmbedding = !previous?.embedding || previous.summary !== summary || previous.placeName !== placeName && eventType !== "stay" || (eventType === "stay" && durationDelta >= 15);
  if (needsEmbedding) void indexEvent(event.toObject());
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
    if (durationMinutes >= MIN_STAY_MINUTES) {
      await saveEvent({ userId, username, eventType: "stay", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: at, recordedAt: at, durationMinutes, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:stay` });
    }
    return;
  }

  const previousDuration = (new Date(visit.lastSeen).getTime() - new Date(visit.startedAt).getTime()) / 60000;
  if (previousDuration >= MIN_STAY_MINUTES) {
    await saveEvent({ userId, username: visit.username, eventType: "stay", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: visit.lastSeen, recordedAt: visit.lastSeen, durationMinutes: previousDuration, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:stay` });
  }
  await saveEvent({ userId, username: visit.username, eventType: "departure", placeName: visit.placeName, latitude: visit.latitude, longitude: visit.longitude, startAt: visit.startedAt, endAt: visit.lastSeen, recordedAt: at, durationMinutes: previousDuration, eventKey: `visit:${userId}:${new Date(visit.startedAt).getTime()}:departure` });
  await startVisit(userId, username, latitude, longitude, at);
}

module.exports = { processLocationEvent, distanceMeters, indexEvent };
