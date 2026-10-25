const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { MobilityTrip, User, Location, Friendship } = require("../models");
const { routeBetween, geocode } = require("../services/routing");
const { emitMobilityEvent } = require("../services/notifications");

const router = express.Router();
router.use(auth);

function validCoordinate(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number(point.latitude) >= -90 && Number(point.latitude) <= 90
    && Number.isFinite(Number(point.longitude)) && Number(point.longitude) >= -180 && Number(point.longitude) <= 180;
}
function cleanTrip(trip) {
  if (!trip) return null;
  const data = trip.toObject ? trip.toObject() : trip;
  return {
    id: String(data._id), status: data.status, transportMode: data.transportMode,
    origin: data.origin, destination: data.destination, route: data.route,
    expectedArrivalAt: data.expectedArrivalAt, originalExpectedArrivalAt: data.originalExpectedArrivalAt,
    lastLocation: data.lastLocation, recipientMode: data.recipientMode,
    recipients: (data.recipients || []).map(String), gracePeriodMinutes: data.gracePeriodMinutes,
    arrivedAt: data.arrivedAt, createdAt: data.createdAt, updatedAt: data.updatedAt
  };
}
async function acceptedFriendIds(userId) {
  const links = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { recipient: userId }] }).lean();
  return links.map(link => String(link.requester) === String(userId) ? String(link.recipient) : String(link.requester));
}
function fail(res, error) {
  return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Mobility request failed." });
}

router.get("/health", (_req, res) => res.json({ success: true, service: "reva-mobility-context" }));

router.get("/geocode", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 3 || query.length > 160) return res.status(400).json({ success: false, message: "Enter a destination with at least 3 characters." });
  try { res.json({ success: true, results: await geocode(query) }); }
  catch (error) { fail(res, error); }
});

router.post("/trips", async (req, res) => {
  try {
    const userId = req.user.userId;
    const destination = req.body.destination;
    const profile = String(req.body.transportMode || "driving-car");
    if (!validCoordinate(destination)) return res.status(400).json({ success: false, message: "Choose a valid destination from search results." });
    if (!["driving-car", "cycling-regular", "foot-walking"].includes(profile)) return res.status(400).json({ success: false, message: "Unsupported transport mode." });

    const active = await MobilityTrip.findOne({ userId, status: { $in: ["ACTIVE", "DELAYED"] } });
    if (active) return res.status(409).json({ success: false, message: "You already have an active journey.", trip: cleanTrip(active) });

    const [user, location] = await Promise.all([
      User.findById(userId).lean(),
      Location.findOne({ userId }).lean()
    ]);
    if (!user || !user.sharingEnabled || !location) return res.status(409).json({ success: false, message: "Turn on location sharing from the Reva main page before starting a journey." });
    if (!location.lastSeen || Date.now() - new Date(location.lastSeen).getTime() > 120000) return res.status(409).json({ success: false, message: "Your latest GPS position is stale. Keep Reva open with sharing enabled until a fresh location arrives, then retry." });
    const origin = { latitude: Number(location.latitude), longitude: Number(location.longitude), label: "Current location" };
    const destinationPoint = {
      latitude: Number(destination.latitude), longitude: Number(destination.longitude),
      label: String(destination.label || "Destination").trim().slice(0, 200)
    };
    const route = await routeBetween(origin, destinationPoint, profile);
    const now = new Date();
    const expectedArrivalAt = new Date(now.getTime() + route.durationSeconds * 1000);

    const friendIds = await acceptedFriendIds(userId);
    const recipientMode = String(req.body.recipientMode || "ALL_FRIENDS");
    if (!["ALL_FRIENDS", "SELECTED_FRIENDS", "ONE_FRIEND"].includes(recipientMode)) {
      return res.status(400).json({ success: false, message: "Invalid notification recipient mode." });
    }
    let recipients = friendIds;
    if (recipientMode !== "ALL_FRIENDS") {
      const requested = Array.isArray(req.body.recipientIds) ? [...new Set(req.body.recipientIds.map(String))] : [];
      if (!requested.length || requested.some(id => !mongoose.isValidObjectId(id) || !friendIds.includes(id))) {
        return res.status(400).json({ success: false, message: "Select one or more accepted friends." });
      }
      if (recipientMode === "ONE_FRIEND" && requested.length !== 1) return res.status(400).json({ success: false, message: "Choose exactly one friend." });
      recipients = requested;
    }

    const trip = await MobilityTrip.create({
      userId, username: user.username || req.user.username || "Reva user",
      status: "ACTIVE", transportMode: profile, origin, destination: destinationPoint, route,
      expectedArrivalAt, originalExpectedArrivalAt: expectedArrivalAt,
      lastRoutedFrom: { latitude: origin.latitude, longitude: origin.longitude, label: origin.label },
      recipientMode, recipients, lastLocation: { latitude: origin.latitude, longitude: origin.longitude, lastSeen: location.lastSeen },
      gracePeriodMinutes: Math.min(60, Math.max(0, Number(req.body.gracePeriodMinutes) || Number(process.env.MOBILITY_ETA_GRACE_MINUTES) || 8))
    });
    await emitMobilityEvent(trip, "journey_started");
    res.status(201).json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

router.get("/trips/active", async (req, res) => {
  try {
    const trip = await MobilityTrip.findOne({ userId: req.user.userId, status: { $in: ["ACTIVE", "DELAYED"] } }).sort({ createdAt: -1 });
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

router.get("/trips/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!trip) return res.status(404).json({ success: false, message: "Journey not found." });
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

router.patch("/trips/:id/recipients", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({ _id: req.params.id, userId: req.user.userId, status: { $in: ["ACTIVE", "DELAYED"] } });
    if (!trip) return res.status(404).json({ success: false, message: "Active journey not found." });
    const mode = String(req.body.recipientMode || "");
    if (!["ALL_FRIENDS", "SELECTED_FRIENDS", "ONE_FRIEND"].includes(mode)) return res.status(400).json({ success: false, message: "Invalid recipient mode." });
    const friendIds = await acceptedFriendIds(req.user.userId);
    let recipients = friendIds;
    if (mode !== "ALL_FRIENDS") {
      recipients = Array.isArray(req.body.recipientIds) ? [...new Set(req.body.recipientIds.map(String))] : [];
      if (!recipients.length || recipients.some(id => !mongoose.isValidObjectId(id) || !friendIds.includes(id))) return res.status(400).json({ success: false, message: "Recipients must be accepted friends." });
      if (mode === "ONE_FRIEND" && recipients.length !== 1) return res.status(400).json({ success: false, message: "Choose exactly one friend." });
    }
    trip.recipientMode = mode;
    trip.recipients = recipients;
    await trip.save();
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

router.post("/trips/:id/arrive", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({ _id: req.params.id, userId: req.user.userId, status: { $in: ["ACTIVE", "DELAYED"] } });
    if (!trip) return res.status(404).json({ success: false, message: "Active journey not found." });
    trip.status = "ARRIVED";
    trip.arrivedAt = new Date();
    trip.endedAt = trip.arrivedAt;
    await trip.save();
    await emitMobilityEvent(trip, "journey_arrived");
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

router.post("/trips/:id/end", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({ _id: req.params.id, userId: req.user.userId, status: { $in: ["ACTIVE", "DELAYED"] } });
    if (!trip) return res.status(404).json({ success: false, message: "Active journey not found." });
    trip.status = req.body.cancel === true ? "CANCELLED" : "COMPLETED";
    trip.endedAt = new Date();
    await trip.save();
    await emitMobilityEvent(trip, "journey_ended");
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});

module.exports = router;
