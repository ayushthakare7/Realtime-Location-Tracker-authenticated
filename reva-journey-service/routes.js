const express = require("express");
const mongoose = require("mongoose");
const Journey = require("./models/Journey");
const { authenticate } = require("./auth");

const router = express.Router();
router.use(authenticate);

const modes = Object.freeze({
  walking: "walking", bicycle: "bicycle", motorcycle: "motorcycle", car: "car",
  scooter: "scooter", auto_rickshaw: "auto_rickshaw", running: "running",
  wheelchair: "wheelchair", kick_scooter: "kick_scooter", skateboard: "skateboard",
  roller_skates: "roller_skates"
});
const avatarFor = Object.freeze({
  walking: "walking", bicycle: "bicycle", motorcycle: "motorcycle", car: "car",
  scooter: "scooter", auto_rickshaw: "auto_rickshaw", running: "running",
  wheelchair: "wheelchair", kick_scooter: "kick_scooter", skateboard: "skateboard",
  roller_skates: "roller_skates"
});
const activeStatuses = ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED"];

function validPoint(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number(point.latitude) >= -90 &&
    Number(point.latitude) <= 90 && Number.isFinite(Number(point.longitude)) &&
    Number(point.longitude) >= -180 && Number(point.longitude) <= 180;
}
function view(journey) {
  return {
    id: String(journey._id), travellerId: journey.travellerId,
    travellerUsername: journey.travellerUsername, status: journey.status,
    origin: journey.origin, destination: journey.destination,
    transportModeId: journey.transportModeId, avatarKey: journey.avatarKey,
    expectedArrivalAt: journey.expectedArrivalAt, sharingEnabled: journey.sharingEnabled,
    sharedWith: journey.sharedWith, lastConfirmedLocation: journey.lastConfirmedLocation,
    arrivedAt: journey.arrivedAt, emergencyAt: journey.emergencyAt,
    createdAt: journey.createdAt, updatedAt: journey.updatedAt
  };
}
function canView(journey, userId) {
  return journey.travellerId === userId ||
    (journey.sharingEnabled && journey.sharedWith.includes(userId));
}

router.get("/health", (req, res) => res.json({ success: true, service: "reva-journey-service", status: "ok" }));
router.get("/modes", (req, res) => res.json({ success: true, modes: Object.keys(modes).map(id => ({ id, avatarKey: avatarFor[id] })) }));

router.post("/", async (req, res) => {
  const { origin, destination, transportModeId, expectedArrivalAt, sharedWith } = req.body || {};
  if (!validPoint(origin) || !validPoint(destination)) return res.status(400).json({ success: false, message: "Valid origin and destination coordinates are required." });
  if (Number(origin.latitude) === Number(destination.latitude) && Number(origin.longitude) === Number(destination.longitude)) {
    return res.status(400).json({ success: false, message: "Origin and destination must be different." });
  }
  if (!Object.hasOwn(modes, transportModeId)) return res.status(400).json({ success: false, message: "Select a supported travel mode." });
  if (expectedArrivalAt && !Number.isFinite(Date.parse(expectedArrivalAt))) return res.status(400).json({ success: false, message: "expectedArrivalAt must be a valid date." });
  const recipients = Array.isArray(sharedWith) ? [...new Set(sharedWith.map(String))] : [];
  if (recipients.length > 100 || recipients.includes(req.authUser.id)) return res.status(400).json({ success: false, message: "Invalid sharedWith list." });
  const journey = await Journey.create({
    travellerId: req.authUser.id, travellerUsername: req.authUser.username,
    origin: { latitude: Number(origin.latitude), longitude: Number(origin.longitude), label: origin.label || null },
    destination: { latitude: Number(destination.latitude), longitude: Number(destination.longitude), label: destination.label || null },
    transportModeId, avatarKey: avatarFor[transportModeId],
    expectedArrivalAt: expectedArrivalAt ? new Date(expectedArrivalAt) : null,
    sharingEnabled: recipients.length > 0, sharedWith: recipients, status: "ACTIVE"
  });
  return res.status(201).json({ success: true, journey: view(journey) });
});

router.get("/", async (req, res) => {
  const journeys = await Journey.find({ travellerId: req.authUser.id }).sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ success: true, journeys: journeys.map(view) });
});

router.get("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const journey = await Journey.findById(req.params.id).lean();
  if (!journey || !canView(journey, req.authUser.id)) return res.status(404).json({ success: false, message: "Journey not found." });
  return res.json({ success: true, journey: view(journey) });
});

router.post("/:id/sync", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const journey = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
  if (!Array.isArray(req.body?.events) || req.body.events.length < 1 || req.body.events.length > 100) {
    return res.status(400).json({ success: false, message: "events must contain between 1 and 100 items." });
  }
  const known = new Set(journey.eventIds);
  let acceptedCount = 0;
  for (const event of req.body.events) {
    if (!event || typeof event.eventId !== "string" || !event.eventId.trim() || event.eventId.length > 128 ||
      !["location", "check_in", "arrival", "offline", "online", "emergency", "cancelled"].includes(event.type)) {
      return res.status(400).json({ success: false, message: "Each event needs a unique eventId and supported type." });
    }
    if (known.has(event.eventId)) continue;
    const recordedAt = event.recordedAt ? new Date(event.recordedAt) : new Date();
    if (!Number.isFinite(recordedAt.getTime())) return res.status(400).json({ success: false, message: "Event recordedAt must be a valid date." });
    const item = { eventId: event.eventId, type: event.type, recordedAt, receivedAt: new Date(), note: typeof event.note === "string" ? event.note.slice(0, 500) : null };
    if (event.type === "location") {
      if (!validPoint(event)) return res.status(400).json({ success: false, message: "Location events need valid coordinates." });
      item.latitude = Number(event.latitude); item.longitude = Number(event.longitude);
      if (event.accuracyMeters != null && Number.isFinite(Number(event.accuracyMeters)) && Number(event.accuracyMeters) >= 0) item.accuracyMeters = Number(event.accuracyMeters);
      if (!journey.lastConfirmedLocation.recordedAt || recordedAt >= journey.lastConfirmedLocation.recordedAt) {
        journey.lastConfirmedLocation = { latitude: item.latitude, longitude: item.longitude, recordedAt, accuracyMeters: item.accuracyMeters ?? null };
      }
    }
    journey.events.push(item); journey.eventIds.push(event.eventId); known.add(event.eventId); acceptedCount++;
    if (event.type === "arrival") { journey.status = "ARRIVED"; journey.arrivedAt = recordedAt; }
    else if (event.type === "emergency") { journey.status = "EMERGENCY_ALERTED"; journey.emergencyAt = recordedAt; }
    else if (event.type === "cancelled") { journey.status = "CANCELLED"; journey.cancelledAt = recordedAt; }
    else if (event.type === "check_in" && ["ALERT_SENT", "EMERGENCY_ALERTED"].includes(journey.status)) journey.status = "ACTIVE";
  }
  await journey.save();
  return res.json({ success: true, acceptedCount, duplicateCount: req.body.events.length - acceptedCount, journey: view(journey) });
});

router.patch("/:id/sharing", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ success: false, message: "enabled must be boolean." });
  const journey = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
  if (req.body.enabled && ["ARRIVED", "CANCELLED"].includes(journey.status)) return res.status(409).json({ success: false, message: "A terminal journey cannot resume sharing." });
  journey.sharingEnabled = req.body.enabled && journey.sharedWith.length > 0;
  await journey.save();
  return res.json({ success: true, sharingEnabled: journey.sharingEnabled });
});

router.post("/:id/cancel", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  const journey = await Journey.findOne({ _id: req.params.id, travellerId: req.authUser.id });
  if (!journey) return res.status(404).json({ success: false, message: "Journey not found." });
  if (!["ARRIVED", "CANCELLED"].includes(journey.status)) {
    journey.status = "CANCELLED"; journey.cancelledAt = new Date(); journey.sharingEnabled = false; await journey.save();
  }
  return res.json({ success: true, journey: view(journey) });
});

module.exports = router;
