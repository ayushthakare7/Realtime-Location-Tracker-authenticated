// Pure request helpers and the accepted-friend query used by mobility controllers.
const { Friendship } = require("../models");

function validCoordinate(point) {
  return Boolean(point
    && Number.isFinite(Number(point.latitude)) && Number(point.latitude) >= -90 && Number(point.latitude) <= 90
    && Number.isFinite(Number(point.longitude)) && Number(point.longitude) >= -180 && Number(point.longitude) <= 180);
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

module.exports = { validCoordinate, cleanTrip, acceptedFriendIds, fail };
