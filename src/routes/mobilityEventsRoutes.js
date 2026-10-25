const express = require("express");
const crypto = require("crypto");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const MobilityNotification = require("../models/MobilityNotification");
const router = express.Router();

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
const copy = {
  journey_started: ["Journey started", "Your friend has started a shared journey."],
  journey_delayed: ["Journey delayed", "Your friend’s latest arrival estimate has shifted. Check the shared route for updates."],
  journey_arrived: ["Arrival confirmed", "Your friend has confirmed arrival at the destination."],
  journey_ended: ["Journey ended", "Your friend’s shared journey has ended."]
};

router.post("/mobility-events", async (req, res) => {
  if (!secretMatches(req.get("x-mobility-secret"), process.env.MOBILITY_CALLBACK_SECRET)) {
    return res.status(401).json({ success: false, message: "Invalid service credential." });
  }
  const event = req.body || {};
  if (!["journey_started", "journey_delayed", "journey_arrived", "journey_ended"].includes(event.type)
      || !/^[a-f\d]{24}$/i.test(String(event.travellerId || ""))
      || !/^[a-f\d]{24}$/i.test(String(event.tripId || ""))) {
    return res.status(400).json({ success: false, message: "Invalid mobility event." });
  }
  const io = req.app.get("io");
  if (!io) return res.status(503).json({ success: false, message: "Realtime transport is not ready." });
  const payload = {
    type: event.type, tripId: String(event.tripId), travellerId: String(event.travellerId),
    travellerUsername: String(event.travellerUsername || "A Reva user").slice(0, 80),
    status: String(event.status || ""), destination: event.destination || null,
    expectedArrivalAt: event.expectedArrivalAt || null, arrivedAt: event.arrivedAt || null,
    lastLocation: event.lastLocation || null, occurredAt: event.occurredAt || new Date().toISOString()
  };
  io.to("user:" + payload.travellerId).emit("mobility-trip-update", payload);

  let recipients = [...new Set((Array.isArray(event.recipientIds) ? event.recipientIds : []).map(String))]
    .filter(id => /^[a-f\d]{24}$/i.test(id) && id !== payload.travellerId);
  const traveller = await User.findById(payload.travellerId).select("sharingEnabled").lean();
  if (!traveller || !traveller.sharingEnabled) recipients = [];
  if (recipients.length) {
    const links = await Friendship.find({
      status: "accepted",
      $or: [
        { requester: payload.travellerId, recipient: { $in: recipients } },
        { recipient: payload.travellerId, requester: { $in: recipients } }
      ]
    }).lean();
    const stillFriends = new Set(links.map(link =>
      String(link.requester) === payload.travellerId ? String(link.recipient) : String(link.requester)
    ));
    recipients = recipients.filter(id => stillFriends.has(id));
  }

  const [title, baseBody] = copy[event.type];
  for (const recipientId of recipients) {
    const destinationLabel = String(event.destination?.label || "").slice(0, 180);
    const body = destinationLabel ? baseBody + " Destination: " + destinationLabel : baseBody;
    const notificationKey = String(event.tripId) + ":" + event.type + ":" + recipientId;
    const notification = await MobilityNotification.findOneAndUpdate(
      { notificationKey },
      { $setOnInsert: {
        notificationKey, recipientId, tripId: event.tripId, type: event.type, title, body,
        payload: { tripId: String(event.tripId), travellerId: payload.travellerId, destination: event.destination || null, expectedArrivalAt: event.expectedArrivalAt || null, status: payload.status }
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    io.to("user:" + recipientId).emit("mobility-notification", {
      ...payload, notificationId: String(notification._id), title: notification.title, body: notification.body
    });
    io.to("user:" + recipientId).emit("mobility-trip-update", payload);
  }
  res.json({ success: true, deliveredTo: recipients.length });
});

module.exports = router;
