const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Location = require("../models/Location");
const LocationPoint = require("../models/LocationPoint");
const LocationVisit = require("../models/LocationVisit");
const { processLocationEvent } = require("../services/locationEvents.service");
const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
const LocationDevice = require("../models/LocationDevice");

module.exports = (io) => {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error("Authentication required"));
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch { next(new Error("Invalid token")); }
  });

  io.on("connection", async (socket) => {
    const userId = socket.user.userId;
    const username = socket.user.username;
    const deviceId = String(socket.handshake.auth && socket.handshake.auth.deviceId || "");
    socket.deviceId = /^[A-Za-z0-9_-]{16,80}$/.test(deviceId) ? deviceId : "";
    socket.join("user:" + userId);
    if (socket.deviceId) {
      try {
        const label = String(socket.handshake.auth && socket.handshake.auth.deviceLabel || "This device").trim().slice(0, 60) || "This device";
        await LocationDevice.findOneAndUpdate(
          { userId, deviceId: socket.deviceId },
          { $set: { label, lastSeen: new Date() }, $setOnInsert: { userId, deviceId: socket.deviceId } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await User.updateOne({ _id: userId, $or: [{ activeLocationDeviceId: { $exists: false } }, { activeLocationDeviceId: "" }, { activeLocationDeviceId: null }] }, { $set: { activeLocationDeviceId: socket.deviceId } });
      } catch (error) { console.error("Location device registration failed:", error.message); }
    }

    try {
      const activeJourneys = await SafetyJourney.find({ travellerId: userId, status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "EMERGENCY_ALERTED"] }, sharingEnabled: true });
      for (const journey of activeJourneys) {
        journey.connectionStatus = "online";
        await journey.save();
        for (const recipientId of journey.sharedWith || []) {
          io.to("user:" + recipientId).emit("journey-update", {
            journeyId: String(journey._id), travellerId: String(userId),
            travellerUsername: journey.travellerUsername, status: journey.status,
            avatarKey: journey.avatarKey, connectionStatus: "online",
            lastConfirmedLocation: journey.lastConfirmedLocation,
            expectedArrivalAt: journey.expectedArrivalAt
          });
        }
      }
      const user = await User.findById(userId).select("sharingEnabled historyEnabled");
      const links = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { recipient: userId }] }).lean();
      const friendIds = links.map(f => String(f.requester) === String(userId) ? f.recipient : f.requester);
      const friends = await User.find({ _id: { $in: friendIds }, sharingEnabled: true }).select("_id username").lean();
      for (const friend of friends) {
        const loc = await Location.findOne({ userId: friend._id }).lean();
        if (loc) socket.emit("receive-location", { userId: String(friend._id), username: friend.username, latitude: loc.latitude, longitude: loc.longitude, lastSeen: loc.lastSeen });
      }
      const sourceUser = await User.findById(userId).select("activeLocationDeviceId").lean();
      socket.emit("sharing-status", { enabled: Boolean(user && user.sharingEnabled), historyEnabled: user?.historyEnabled !== false, activeDeviceId: sourceUser?.activeLocationDeviceId || "" });
    } catch (e) { console.error("Socket initialization failed:", e.message); }

    socket.on("send-location", async (data) => {
      try {
        const latitude = Number(data && data.latitude);
        const longitude = Number(data && data.longitude);
        const rawAccuracy = Number(data && (data.accuracyMeters ?? data.accuracy));
        const accuracyMeters = Number.isFinite(rawAccuracy) && rawAccuracy >= 0 && rawAccuracy <= 10000 ? rawAccuracy : null;
        if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return;
        const user = await User.findById(userId).select("sharingEnabled historyEnabled username activeLocationDeviceId");
        if (!user || !user.sharingEnabled) return;
        // Ignore GPS updates from devices that are not the account's active source.
        if (!socket.deviceId || user.activeLocationDeviceId !== socket.deviceId) return;
        const now = new Date();
        await LocationDevice.updateOne({ userId, deviceId: socket.deviceId }, { $set: { lastSeen: now } });
        await Location.findOneAndUpdate({ userId }, { userId, username: user.username || username, latitude, longitude, accuracyMeters, lastSeen: now }, { upsert: true, new: true });
        if (user.historyEnabled !== false) {
          await LocationPoint.create({ userId, username: user.username || username, latitude, longitude, recordedAt: now });
          await processLocationEvent({ userId, username: user.username || username, latitude, longitude, recordedAt: now });
        }
        const links = await Friendship.find({ status: "accepted", $or: [{ requester: userId }, { recipient: userId }] }).lean();
        const friendIds = links.map(f => String(f.requester) === String(userId) ? f.recipient : f.requester);
        const recipients = await User.find({ _id: { $in: friendIds } }).select("_id").lean();
        const payload = { userId: String(userId), username: user.username || username, latitude, longitude, accuracyMeters, lastSeen: now };
        for (const recipient of recipients) io.to("user:" + recipient._id).emit("receive-location", payload);
      } catch (e) { console.error("Location update failed:", e.message); }
    });

    socket.on("disconnect", async () => {
      console.log("Socket disconnected:", socket.id);
      try {
        const remainingSockets = await io.in("user:" + userId).fetchSockets();
        if (remainingSockets.length > 0) return;
        const activeJourneys = await SafetyJourney.find({
          travellerId: userId,
          status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED"] },
          sharingEnabled: true
        });
        for (const journey of activeJourneys) {
          journey.connectionStatus = "offline";
          await journey.save();
          for (const recipientId of journey.sharedWith || []) {
            io.to("user:" + recipientId).emit("journey-update", {
              journeyId: String(journey._id), travellerId: String(userId),
              travellerUsername: journey.travellerUsername, status: journey.status,
              avatarKey: journey.avatarKey, connectionStatus: "offline",
              lastConfirmedLocation: journey.lastConfirmedLocation,
              expectedArrivalAt: journey.expectedArrivalAt
            });
          }
        }
      } catch (error) {
        console.error("Journey connection state update failed:", error.message);
      }
    });
  });
};
