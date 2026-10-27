// Destination lookup and service-health handlers.
const mongoose = require("mongoose");
const { MobilityTrip, User, Location, Friendship } = require("../models");
const { routeBetween, geocode } = require("../services/routing");
const { emitMobilityEvent } = require("../services/notifications");
const { validCoordinate, cleanTrip, acceptedFriendIds, fail } = require("../utils/trips");

module.exports = {
  health: (_req, res) => res.json({ success: true, service: "reva-mobility-context" }),

  geocode: async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 3 || query.length > 160) return res.status(400).json({ success: false, message: "Enter a destination with at least 3 characters." });
  try { res.json({ success: true, results: await geocode(query) }); }
  catch (error) { fail(res, error); }
}
};
