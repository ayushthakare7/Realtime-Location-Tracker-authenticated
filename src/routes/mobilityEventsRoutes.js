const express = require("express");
const crypto = require("crypto");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const MobilityNotification = require("../models/MobilityNotification");
const { sendPushToUser } = require("../services/pushNotification.service");
const router = express.Router();

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function travellerNotification(type, name) {
  // Spooky-cute copy: personal and memorable, without sounding threatening.
  const copy = {
    journey_started: [`👁️ ${name} is on the move`, `The map noticed: ${name} just started a journey. Keep an eye on their route.`],
    journey_delayed: [`🕯️ ${name} is running late`, `${name} has not arrived yet. Their shared route is still worth a look.`],
    journey_arrived: [`🌙 ${name} made it safely`, `${name} reached the destination. All quiet on the map—for now.`],
    journey_ended: [`🫥 ${name}'s journey went quiet`, `${name}'s shared journey has ended. The trail fades from here.`]
  };
  return copy[type] || [`👀 Update from ${name}`, `${name} has a new journey update in Reva.`];
}

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
  const traveller = await User.findById(payload.travellerId).select("sharingEnabled username").lean();
  const travellerName = String(traveller?.username || payload.travellerUsername || "A Reva user").trim().slice(0, 60) || "A Reva user";
  payload.travellerUsername = travellerName;
  io.to("user:" + payload.travellerId).emit("mobility-trip-update", payload);

  let recipients = [...new Set((Array.isArray(event.recipientIds) ? event.recipientIds : []).map(String))]
    .filter(id => /^[a-f\d]{24}$/i.test(id) && id !== payload.travellerId);
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

  const [title, baseBody] = travellerNotification(event.type, travellerName);
  for (const recipientId of recipients) {
    const destinationLabel = String(event.destination?.label || "").slice(0, 180);
    const body = destinationLabel ? baseBody + " Destination: " + destinationLabel : baseBody;
    const notificationKey = String(event.tripId) + ":" + event.type + ":" + recipientId;
    const wasAlreadyCreated = await MobilityNotification.exists({ notificationKey });
    const notification = await MobilityNotification.findOneAndUpdate(
      { notificationKey },
      { $setOnInsert: {
        notificationKey, recipientId, tripId: event.tripId, type: event.type, title, body,
        payload: { tripId: String(event.tripId), travellerId: payload.travellerId, destination: event.destination || null, expectedArrivalAt: event.expectedArrivalAt || null, status: payload.status, viewPath: "/mobility/shared/" + String(event.tripId) }
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!wasAlreadyCreated) {
      await sendPushToUser({
        userId: recipientId, title: notification.title, body: notification.body,
        data: { ...(notification.payload || {}), viewPath: "/mobility/shared/" + String(event.tripId) }
      });
    }
    io.to("user:" + recipientId).emit("mobility-notification", {
      ...payload, notificationId: String(notification._id), title: notification.title, body: notification.body, viewPath: "/mobility/shared/" + String(event.tripId)
    });
    io.to("user:" + recipientId).emit("mobility-trip-update", payload);
  }
  if (["journey_delayed", "journey_arrived"].includes(event.type) && traveller && traveller.sharingEnabled) {
    const travellerCopy = event.type === "journey_delayed"
      ? ["🕰️ Your journey is taking longer", "Your expected arrival time has shifted or passed. Check the latest route and GPS update."]
      : ["🌙 You made it", "Arrival confirmed. Your journey is complete—time to breathe easy."];
    const notificationKey = String(event.tripId) + ":" + event.type + ":" + payload.travellerId;
    const wasAlreadyCreated = await MobilityNotification.exists({ notificationKey });
    const notification = await MobilityNotification.findOneAndUpdate(
      { notificationKey },
      { $setOnInsert: { notificationKey, recipientId: payload.travellerId, tripId: event.tripId, type: event.type, title: travellerCopy[0], body: travellerCopy[1], payload: { tripId: String(event.tripId), travellerId: payload.travellerId, destination: event.destination || null, expectedArrivalAt: event.expectedArrivalAt || null, status: payload.status, viewPath: "/mobility" } } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    if (!wasAlreadyCreated) {
      await sendPushToUser({ userId: payload.travellerId, title: notification.title, body: notification.body, data: notification.payload });
    }
    io.to("user:" + payload.travellerId).emit("mobility-notification", { ...payload, notificationId: String(notification._id), title: notification.title, body: notification.body, viewPath: "/mobility" });
  }
  res.json({ success: true, deliveredTo: recipients.length });
});

module.exports = router;
