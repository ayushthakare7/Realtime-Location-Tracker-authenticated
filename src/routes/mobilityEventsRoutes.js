const express = require("express");
const crypto = require("crypto");
const router = express.Router();
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided)), right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
router.post("/mobility-events", (req, res) => {
  if (!secretMatches(req.get("x-mobility-secret"), process.env.MOBILITY_CALLBACK_SECRET)) return res.status(401).json({ success: false, message: "Invalid service credential." });
  const event = req.body || {};
  if (!["journey_started", "journey_delayed", "journey_arrived", "journey_ended"].includes(event.type) || !/^[a-f\d]{24}$/i.test(String(event.travellerId || ""))) return res.status(400).json({ success: false, message: "Invalid mobility event." });
  const io = req.app.get("io");
  if (!io) return res.status(503).json({ success: false, message: "Realtime transport is not ready." });
  const payload = { type: event.type, tripId: String(event.tripId || ""), travellerId: String(event.travellerId), travellerUsername: String(event.travellerUsername || "A Reva user").slice(0, 80), status: String(event.status || ""), destination: event.destination || null, expectedArrivalAt: event.expectedArrivalAt || null, arrivedAt: event.arrivedAt || null, lastLocation: event.lastLocation || null, occurredAt: event.occurredAt || new Date().toISOString() };
  io.to("user:" + payload.travellerId).emit("mobility-trip-update", payload);
  const recipients = [...new Set((Array.isArray(event.recipientIds) ? event.recipientIds : []).map(String))].filter(id => /^[a-f\d]{24}$/i.test(id) && id !== payload.travellerId);
  for (const recipientId of recipients) {
    io.to("user:" + recipientId).emit("mobility-notification", payload);
    io.to("user:" + recipientId).emit("mobility-trip-update", payload);
  }
  res.json({ success: true, deliveredTo: recipients.length });
});
module.exports = router;
