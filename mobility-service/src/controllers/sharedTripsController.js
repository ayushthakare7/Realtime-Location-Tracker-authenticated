// Recipient-authorized shared journey handlers.
const mongoose = require("mongoose");
const { MobilityTrip, User, Location, Friendship } = require("../models");
const { routeBetween, geocode } = require("../services/routing");
const { emitMobilityEvent } = require("../services/notifications");
const { validCoordinate, cleanTrip, acceptedFriendIds, fail } = require("../utils/trips");

module.exports = {
  listSharedTrips: async (req, res) => {
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
},

  dismissSharedTrip: async (req, res) => {
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
},

  getSharedTrip: async (req, res) => {
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
}
};
