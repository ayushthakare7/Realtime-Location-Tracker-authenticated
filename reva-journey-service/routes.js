const express = require("express");
const mongoose = require("mongoose");
const Journey = require("./models/Journey");
const Notification = require("./models/Notification");
const { authenticate } = require("./auth");
const { calculateRoute, validatePoint } = require("./routing");
const { queueNotification } = require("./worker");

const router = express.Router();
router.use(authenticate);
const modes = Object.freeze({
  walking: "walking", bicycle: "bicycle", motorcycle: "motorcycle", car: "car",
  scooter: "scooter", auto_rickshaw: "auto_rickshaw", running: "running",
  wheelchair: "wheelchair", kick_scooter: "kick_scooter", skateboard: "skateboard",
  roller_skates: "roller_skates"
});
const terminal = ["ARRIVED", "CANCELLED"];
const activeStatuses = ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED"];

function view(j) {
  return { id: String(j._id), travellerId: j.travellerId, travellerUsername: j.travellerUsername,
    status: j.status, origin: j.origin, destination: j.destination, route: j.route || null,
    transportModeId: j.transportModeId, avatarKey: j.avatarKey, expectedArrivalAt: j.expectedArrivalAt,
    sharingEnabled: j.sharingEnabled, sharedWith: j.sharedWith, lastConfirmedLocation: j.lastConfirmedLocation,
    arrivedAt: j.arrivedAt, emergencyAt: j.emergencyAt, createdAt: j.createdAt, updatedAt: j.updatedAt };
}
function canView(j, userId) {
  return j.travellerId === userId || (j.sharingEnabled && j.sharedWith.includes(userId));
}
function validId(id) { return mongoose.isValidObjectId(id); }
async function notify(journey, type, title, body, suffix, recipients = journey.sharingEnabled ? journey.sharedWith : []) {
  for (const recipientId of [...new Set(recipients.map(String))]) {
    await queueNotification({ journey, recipientId, type, title, body, keySuffix: suffix });
  }
}
async function geocode(text) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2"); url.searchParams.set("limit", "1"); url.searchParams.set("q", text);
  let response;
  try {
    response = await fetch(url, { headers: { "user-agent": "RevaSafetyTravel/1.0 (open-source project)", "accept-language": "en" }, signal: AbortSignal.timeout(10000) });
  } catch { const e = new Error("The free geocoding service is temporarily unavailable."); e.status = 503; throw e; }
  if (!response.ok) { const e = new Error("Geocoding provider returned HTTP " + response.status + "."); e.status = response.status === 429 || response.status >= 500 ? 503 : 502; throw e; }
  const results = await response.json(), first = results[0];
  if (!first) { const e = new Error("Place could not be found. Add a more specific address."); e.status = 422; throw e; }
  return { latitude: Number(first.lat), longitude: Number(first.lon), label: String(first.display_name || text).slice(0, 200) };
}

router.get("/modes", (req, res) => res.json({ success: true, modes: Object.keys(modes).map(id => ({ id, avatarKey: id })) }));
router.get("/notifications", async (req, res) => {
  const items = await Notification.find({ recipientId: req.authUser.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, notifications: items.map(n => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, payload: n.payload, createdAt: n.createdAt, readAt: n.readAt })) });
});
router.patch("/notifications/:notificationId/read", async (req, res) => {
  if (!validId(req.params.notificationId)) return res.status(400).json({ success: false, message: "Invalid notification ID." });
  const n = await Notification.findOneAndUpdate({ _id: req.params.notificationId, recipientId: req.authUser.id }, { $set: { readAt: new Date() } }, { new: true }).lean();
  if (!n) return res.status(404).json({ success: false, message: "Notification not found." });
  res.json({ success: true, id: String(n._id), readAt: n.readAt });
});

router.post("/", async (req, res) => {
  const b = req.body || {};
  let origin = b.origin, destination = b.destination;
  if ((!validatePoint(origin) || !validatePoint(destination)) && b.originText && b.destinationText) {
    origin = await geocode(b.originText); destination = await geocode(b.destinationText);
  }
  if (!validatePoint(origin) || !validatePoint(destination)) return res.status(400).json({ success: false, message: "Valid origin/destination coordinates or place text are required." });
  if (Number(origin.latitude) === Number(destination.latitude) && Number(origin.longitude) === Number(destination.longitude)) return res.status(400).json({ success: false, message: "Origin and destination must be different." });
  if (!Object.hasOwn(modes, b.transportModeId)) return res.status(400).json({ success: false, message: "Select a supported travel mode." });
  if (b.expectedArrivalAt && !Number.isFinite(Date.parse(b.expectedArrivalAt))) return res.status(400).json({ success: false, message: "expectedArrivalAt must be a valid date." });
  const recipients = Array.isArray(b.sharedWith) ? [...new Set(b.sharedWith.map(String))] : [];
  if (recipients.length > 100 || recipients.some(id => !validId(id) || id === req.authUser.id)) return res.status(400).json({ success: false, message: "Invalid sharedWith list." });
  if (recipients.length) {
    const Friendship = require("./models/Friendship");
    const links = await Friendship.find({ status: "accepted", $or: [
      { requester: req.authUser.id, recipient: { $in: recipients } },
      { recipient: req.authUser.id, requester: { $in: recipients } }
    ] }).lean();
    const accepted = new Set(links.map(f => String(f.requester) === req.authUser.id ? String(f.recipient) : String(f.requester)));
    if (recipients.some(id => !accepted.has(id))) return res.status(403).json({ success: false, message: "Every shared recipient must be an accepted Reva friend." });
  }
  const journey = await Journey.create({ travellerId: req.authUser.id, travellerUsername: req.authUser.username,
    origin: { latitude: Number(origin.latitude), longitude: Number(origin.longitude), label: origin.label || null },
    destination: { latitude: Number(destination.latitude), longitude: Number(destination.longitude), label: destination.label || null },
    transportModeId: b.transportModeId, avatarKey: b.transportModeId, expectedArrivalAt: b.expectedArrivalAt ? new Date(b.expectedArrivalAt) : null,
    sharingEnabled: recipients.length > 0, sharedWith: recipients, status: "ACTIVE" });
  if (journey.sharingEnabled) await notify(journey, "journey_shared", "A friend is sharing a Safety Travel journey",
    journey.travellerUsername + " started a shared journey.", "shared:" + journey._id);
  res.status(201).json({ success: true, journey: view(journey) });
});

router.post("/:id/routes", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const journey = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
  if (!["DRAFT", "ACTIVE"].includes(journey.status) || journey.events.length) return res.status(409).json({ success: false, message: "Route cannot be changed after tracking events begin." });
  const route = await calculateRoute({ origin: journey.origin, destination: journey.destination, modeId: journey.transportModeId });
  journey.route = { provider: route.provider, distanceMeters: route.distanceMeters, durationSeconds: route.durationSeconds, encodedPolyline: route.encodedPolyline, routeLabels: route.routeLabels, approvedAt: new Date() };
  if (!journey.expectedArrivalAt) journey.expectedArrivalAt = new Date(Date.now() + route.durationSeconds * 1000);
  await journey.save();
  res.json({ success: true, route: journey.route, expectedArrivalAt: journey.expectedArrivalAt, requiresApproval: true });
});

router.get("/", async (req, res) => {
  const journeys = await Journey.find({ travellerId: req.authUser.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, journeys: journeys.map(view) });
});
router.get("/shared", async (req, res) => {
  const journeys = await Journey.find({ sharedWith: req.authUser.id, sharingEnabled: true, status: { $in: activeStatuses.concat(["ARRIVED"]) } }).sort({ updatedAt: -1 }).limit(100).lean();
  res.json({ success: true, journeys: journeys.map(view) });
});
router.get("/:id", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const j = await Journey.findById(req.params.id).lean();
  if (!j || !canView(j, req.authUser.id)) return res.status(404).json({ success: false, message: "Journey not found." });
  res.json({ success: true, journey: view(j) });
});

router.post("/:id/sync", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const j = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!j) return res.status(404).json({ success: false, message: "Journey not found." });
  if (!Array.isArray(req.body?.events) || req.body.events.length < 1 || req.body.events.length > 100) return res.status(400).json({ success: false, message: "events must contain between 1 and 100 items." });
  const known = new Set(j.eventIds); let acceptedCount = 0;
  for (const event of req.body.events) {
    if (!event || typeof event.eventId !== "string" || !event.eventId.trim() || event.eventId.length > 128 || !["location","check_in","arrival","offline","online","emergency","cancelled"].includes(event.type)) return res.status(400).json({ success: false, message: "Each event needs an eventId and supported type." });
    if (known.has(event.eventId)) continue;
    const recordedAt = event.recordedAt ? new Date(event.recordedAt) : new Date();
    if (!Number.isFinite(recordedAt.getTime()) || recordedAt.getTime() > Date.now() + 5 * 60_000 || recordedAt.getTime() < Date.now() - 8 * 24 * 60 * 60_000) return res.status(400).json({ success: false, message: "Event timestamp is invalid or outside the allowed 7-day sync window." });
    const item = { eventId: event.eventId, type: event.type, recordedAt, receivedAt: new Date(), note: typeof event.note === "string" ? event.note.slice(0, 500) : null };
    if (event.type === "location") {
      if (!validatePoint(event)) return res.status(400).json({ success: false, message: "Location events need valid coordinates." });
      item.latitude = Number(event.latitude); item.longitude = Number(event.longitude);
      if (event.accuracyMeters != null && Number.isFinite(Number(event.accuracyMeters)) && Number(event.accuracyMeters) >= 0) item.accuracyMeters = Number(event.accuracyMeters);
      if (!j.lastConfirmedLocation.recordedAt || recordedAt >= j.lastConfirmedLocation.recordedAt) j.lastConfirmedLocation = { latitude: item.latitude, longitude: item.longitude, recordedAt, accuracyMeters: item.accuracyMeters ?? null };
    }
    j.events.push(item); j.eventIds.push(event.eventId); known.add(event.eventId); acceptedCount++;
    if (event.type === "arrival" && !terminal.includes(j.status)) { j.status = "ARRIVED"; j.arrivedAt = recordedAt; j.sharingEnabled = false; }
    else if (event.type === "emergency" && !terminal.includes(j.status)) { j.status = "EMERGENCY_ALERTED"; j.emergencyAt = recordedAt; }
    else if (event.type === "cancelled" && !terminal.includes(j.status)) { j.status = "CANCELLED"; j.cancelledAt = recordedAt; j.sharingEnabled = false; }
    else if (event.type === "check_in" && ["OVERDUE_UNCONFIRMED","ALERT_SENT"].includes(j.status)) j.status = "ACTIVE";
  }
  await j.save();
  if (acceptedCount) {
    if (j.status === "ARRIVED") await notify(j, "journey_arrived", "Your friend has arrived", j.travellerUsername + " has arrived safely at the destination.", "arrived:" + (j.arrivedAt?.toISOString() || j._id));
    if (j.status === "EMERGENCY_ALERTED") await notify(j, "journey_emergency", "Emergency alert from your friend", j.travellerUsername + " explicitly requested help during Safety Travel. Try contacting them and contact local emergency services if needed.", "emergency:" + (j.emergencyAt?.toISOString() || j._id));
    if (j.status === "CANCELLED") await notify(j, "journey_cancelled", "Journey cancelled", j.travellerUsername + " cancelled their shared journey.", "cancelled:" + (j.cancelledAt?.toISOString() || j._id));
    if (req.body.events.some(e => e.type === "check_in")) {
      await notify(j, "journey_arrived", "Safety check-in received", j.travellerUsername + " has checked in. Confirm their status directly if you are concerned.", "checkin:" + Date.now(), j.sharedWith);
    }
  }
  res.json({ success: true, acceptedCount, duplicateCount: req.body.events.length - acceptedCount, journey: view(j) });
});

router.patch("/:id/sharing", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ success: false, message: "enabled must be boolean." });
  const j = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!j) return res.status(404).json({ success: false, message: "Journey not found." });
  if (req.body.enabled && terminal.includes(j.status)) return res.status(409).json({ success: false, message: "A terminal journey cannot resume sharing." });
  j.sharingEnabled = req.body.enabled && j.sharedWith.length > 0; await j.save();
  res.json({ success: true, sharingEnabled: j.sharingEnabled });
});
router.post("/:id/cancel", async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const j = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!j) return res.status(404).json({ success: false, message: "Journey not found." });
  if (!terminal.includes(j.status)) { j.status = "CANCELLED"; j.cancelledAt = new Date(); j.sharingEnabled = false; await j.save(); }
  res.json({ success: true, journey: view(j) });
});
module.exports = router;
