const express = require("express");
const mongoose = require("mongoose");
const auth = require("../middleware/auth");
const { MobilityTrip, User, Location, Friendship } = require("../models");
const { routeBetween, geocode } = require("../services/routing");
const { emitMobilityEvent } = require("../services/notifications");

const router = express.Router();
router.use(auth);

const requestWindows = new Map();
router.use((req, res, next) => {
  const now = Date.now();
  const userKey = String(req.user.userId || "unknown");
  const kind = req.path.startsWith("/geocode") ? "geocode" : "api";
  const key = userKey + ":" + kind;
  const limit = kind === "geocode" ? 12 : 90;
  let bucket = requestWindows.get(key);
  if (!bucket || now - bucket.startedAt >= 60000) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  requestWindows.set(key, bucket);
  if (requestWindows.size > 5000) {
    for (const [entryKey, entry] of requestWindows) if (now - entry.startedAt >= 60000) requestWindows.delete(entryKey);
  }
  if (bucket.count > limit) return res.status(429).json({ success: false, message: kind === "geocode" ? "Destination search is rate-limited to protect the free routing quota. Please wait a minute." : "Too many mobility requests. Please wait a moment." });
  next();
});


function validCoordinate(point) {
  return point && Number.isFinite(Number(point.latitude)) && Number(point.latitude) >= -90 && Number(point.latitude) <= 90
    && Number.isFinite(Number(point.longitude)) && Number(point.longitude) >= -180 && Number(point.longitude) <= 180;
}
function cleanTrip(trip) {
  if (!trip) return null;
  const data = trip.toObject ? trip.toObject() : trip;
  return {
    id: String(data._id), travellerId: String(data.userId), travellerUsername: data.username, status: data.status, transportMode: data.transportMode,
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
    if (!["driving-car", "cycling-regular", "motorbike", "foot-walking", "bus", "train"].includes(profile)) return res.status(400).json({ success: false, message: "Unsupported transport mode." });

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
    // Only an ongoing journey belongs in the active-trip slot.
    // Completed journeys remain in history and friends' arrival cards, not as the current ride.
    const trip = await MobilityTrip.findOne({
      userId: req.user.userId,
      status: { $in: ["ACTIVE", "DELAYED"] }
    }).sort({ createdAt: -1 });
    res.json({ success: true, trip: cleanTrip(trip) });
  } catch (error) { fail(res, error); }
});


router.get("/trips/shared", async (req, res) => {
  try {
    const friendIds = await acceptedFriendIds(req.user.userId);
    if (!friendIds.length) return res.json({ success: true, trips: [] });
    const [trips, sharingUsers] = await Promise.all([
      MobilityTrip.find({
        userId: { $in: friendIds },
        recipients: req.user.userId,
        dismissedBy: { $ne: req.user.userId },
        status: { $in: ["ACTIVE", "DELAYED", "ARRIVED", "COMPLETED"] }
      }).sort({ updatedAt: -1 }).limit(30).lean(),
      User.find({ _id: { $in: friendIds }, sharingEnabled: true }).select("_id").lean()
    ]);
    const currentlySharing = new Set(sharingUsers.map(user => String(user._id)));
    const visible = trips.filter(trip =>
      ["ARRIVED", "COMPLETED"].includes(trip.status) || currentlySharing.has(String(trip.userId))
    ).map(trip => ({
      id: String(trip._id),
      travellerUsername: trip.username || "Your friend",
      status: trip.status,
      transportMode: trip.transportMode,
      destination: { label: trip.destination?.label || "Destination" },
      expectedArrivalAt: trip.expectedArrivalAt,
      arrivedAt: trip.arrivedAt || null,
      endedAt: trip.endedAt || null,
      updatedAt: trip.updatedAt
    }));
    res.json({ success: true, trips: visible });
  } catch (error) { fail(res, error); }
});

router.post("/trips/shared/:id/dismiss", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({
      _id: req.params.id,
      recipients: req.user.userId,
      status: { $in: ["ARRIVED", "COMPLETED"] }
    });
    if (!trip) return res.status(404).json({ success: false, message: "Completed shared journey not found." });
    const friendship = await Friendship.findOne({ status: "accepted", $or: [
      { requester: trip.userId, recipient: req.user.userId },
      { requester: req.user.userId, recipient: trip.userId }
    ] }).lean();
    if (!friendship) return res.status(403).json({ success: false, message: "You no longer have access to this friend's journey." });
    await MobilityTrip.updateOne(
      { _id: trip._id, recipients: req.user.userId },
      { $addToSet: { dismissedBy: req.user.userId } }
    );
    res.json({ success: true });
  } catch (error) { fail(res, error); }
});

router.get("/trips/shared/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid journey ID." });
  try {
    const trip = await MobilityTrip.findOne({ _id: req.params.id, recipients: req.user.userId });
    if (!trip) return res.status(404).json({ success: false, message: "Shared journey not found or you do not have permission to view it." });
    const friendship = await Friendship.findOne({ status: "accepted", $or: [
      { requester: trip.userId, recipient: req.user.userId },
      { requester: req.user.userId, recipient: trip.userId }
    ] }).lean();
    const traveller = await User.findById(trip.userId).select("sharingEnabled").lean();
    if (!friendship || !traveller?.sharingEnabled) return res.status(403).json({ success: false, message: "The journey is no longer shared with you." });
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
