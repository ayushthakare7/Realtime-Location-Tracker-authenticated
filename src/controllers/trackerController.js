const User = require("../models/User");
const Location = require("../models/Location");
const LocationPoint = require("../models/LocationPoint");
const LocationVisit = require("../models/LocationVisit");
const LocationEvent = require("../models/LocationEvent");
const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
const { askRagService } = require("../services/ragClient.service");
const { placeLabel, reverseGeocode } = require("../services/locationEvents.service");

exports.setSharing = async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    await User.findByIdAndUpdate(req.user.userId, { sharingEnabled: enabled });
    if (!enabled) {
      await Location.deleteOne({ userId: req.user.userId });
      await LocationVisit.deleteOne({ userId: req.user.userId });
      const links = await Friendship.find({ status: "accepted", $or: [{ requester: req.user.userId }, { recipient: req.user.userId }] }).lean();
      const friendIds = links.map(f => String(f.requester) === String(req.user.userId) ? f.recipient : f.requester);
      for (const friendId of friendIds) req.app.get("io")?.to("user:" + friendId).emit("sharing-stopped", { userId: String(req.user.userId) });
    }
    res.json({ success: true, sharingEnabled: enabled });
  } catch { res.status(500).json({ success: false, message: "Could not update sharing." }); }
};

exports.sendFriendRequest = async (req, res) => {
  try {
    const target = await User.findOne({ username: String(req.body.username || "").trim() }).select("_id");
    if (!target || String(target._id) === String(req.user.userId)) return res.status(400).json({ success: false, message: "Invalid username." });
    const exists = await Friendship.findOne({ $or: [{ requester: req.user.userId, recipient: target._id }, { requester: target._id, recipient: req.user.userId }] });
    if (exists) return res.status(409).json({ success: false, message: "Request or friendship already exists." });
    await Friendship.create({ requester: req.user.userId, recipient: target._id });
    req.app.get("io")?.to("user:" + target._id).emit("friend-request-received", { username: req.user.username || "A user" });
    res.status(201).json({ success: true });
  } catch { res.status(500).json({ success: false, message: "Could not send request." }); }
};

exports.respondToRequest = async (req, res) => {
  try {
    const request = await Friendship.findOne({ _id: req.params.id, recipient: req.user.userId, status: "pending" });
    if (!request || !["accepted", "declined"].includes(req.body.status)) return res.status(400).json({ success: false, message: "Invalid request or status." });
    request.status = req.body.status;
    await request.save();
    res.json({ success: true, status: request.status });
  } catch { res.status(500).json({ success: false, message: "Could not respond." }); }
};


exports.removeFriend = async (req, res) => {
  try {
    const uid = String(req.user.userId);
    const friendId = String(req.params.id || "");
    if (!/^[a-f\d]{24}$/i.test(friendId) || friendId === uid) {
      return res.status(400).json({ success: false, message: "Invalid friend." });
    }
    const friendship = await Friendship.findOneAndDelete({
      status: "accepted",
      $or: [
        { requester: uid, recipient: friendId },
        { requester: friendId, recipient: uid }
      ]
    });
    if (!friendship) {
      return res.status(404).json({ success: false, message: "Friendship not found." });
    }
    await Promise.all([
      SafetyJourney.updateMany({ travellerId: uid, sharedWith: friendId }, { $pull: { sharedWith: friendId } }),
      SafetyJourney.updateMany({ travellerId: friendId, sharedWith: uid }, { $pull: { sharedWith: uid } })
    ]);
    req.app.get("io")?.to("user:" + friendId).emit("friend-removed", { userId: uid });
    req.app.get("io")?.to("user:" + uid).emit("friend-removed", { userId: friendId });
    res.json({ success: true, message: "Friend removed." });
  } catch {
    res.status(500).json({ success: false, message: "Could not remove friend." });
  }
};

exports.setHistory = async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    await User.findByIdAndUpdate(req.user.userId, { historyEnabled: enabled });
    res.json({ success: true, historyEnabled: enabled });
  } catch { res.status(500).json({ success: false, message: "Could not update history setting." }); }
};

exports.deleteHistory = async (req, res) => {
  try {
    const uid = req.user.userId;
    await Promise.all([LocationPoint.deleteMany({ userId: uid }), LocationVisit.deleteMany({ userId: uid }), LocationEvent.deleteMany({ userId: uid })]);
    res.json({ success: true, message: "Your location history was deleted." });
  } catch { res.status(500).json({ success: false, message: "Could not delete location history." }); }
};

exports.listFriends = async (req, res) => {
  try {
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).populate("requester", "username sharingEnabled").populate("recipient", "username sharingEnabled");
    const friends = await Promise.all(links.map(async f => {
      const u = String(f.requester._id) === String(uid) ? f.recipient : f.requester;
      const [loc, visit] = u.sharingEnabled ? await Promise.all([Location.findOne({ userId: u._id }).lean(), LocationVisit.findOne({ userId: u._id }).lean()]) : [null, null];
      return { id: String(u._id), username: u.username, sharingEnabled: Boolean(u.sharingEnabled), location: loc ? { latitude: loc.latitude, longitude: loc.longitude, lastSeen: loc.lastSeen, placeName: visit?.placeName || null } : null };
    }));
    const requests = await Friendship.find({ recipient: uid, status: "pending" }).populate("requester", "username");
    const me = await User.findById(uid).select("sharingEnabled historyEnabled");
    res.json({ success: true, friends, requests: requests.map(f => ({ id: String(f._id), username: f.requester.username })), sharingEnabled: Boolean(me && me.sharingEnabled), historyEnabled: me?.historyEnabled !== false });
  } catch { res.status(500).json({ success: false, message: "Could not load friends." }); }
};

exports.history = async (req, res) => {
  try {
    const uid = req.user.userId;
    const user = await User.findById(uid).select("historyEnabled").lean();
    if (!user?.historyEnabled) return res.json({ success: true, historyEnabled: false, visits: [], events: [] });
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ success: false, message: "Invalid history range." });
    const [visits, events] = await Promise.all([
      LocationVisit.find({ userId: uid, startedAt: { $gte: from, $lte: to } }).sort({ startedAt: 1 }).lean(),
      LocationEvent.find({ userId: uid, recordedAt: { $gte: from, $lte: to } }).sort({ recordedAt: 1 }).lean()
    ]);
    res.json({ success: true, historyEnabled: true, visits: visits.map(v => ({ id: String(v._id), placeName: v.placeName, latitude: v.latitude, longitude: v.longitude, startedAt: v.startedAt, lastSeen: v.lastSeen, pointCount: v.pointCount })), events: events.map(e => ({ id: String(e._id), eventType: e.eventType, placeName: e.placeName, summary: e.summary, startAt: e.startAt, endAt: e.endAt, durationMinutes: e.durationMinutes, latitude: e.latitude, longitude: e.longitude })) });
  } catch { res.status(500).json({ success: false, message: "Could not load history." }); }
};

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isCurrentQuestion(question) { return /\b(right now|currently|current location|current place|where is .* now|where .* now|where .* currently)\b/i.test(question); }
function isOwnCurrentQuestion(question) { return /\b(where am i|where i'm|where i am|my current location|my current place|where is my location|where is me)\b/i.test(question); }
function isGeoAddressQuestion(question) { return /\b(which city|what city|which state|what state|which country|what country|city.*state.*country|state.*country|country.*city|city and state|city and country|state and country|in which city|in what city)\b/i.test(question); }
function requestedUsername(question, usernames) { const lower = question.toLowerCase(); return usernames.find(name => lower.includes(String(name).toLowerCase())); }
function isFallbackPlace(place) { return !place || /^Location near -?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/i.test(String(place).trim()); }

exports.askMap = async (req, res) => {
  try {
    const question = String(req.body.question || "").trim();
    if (!question || question.length > 500) return res.status(400).json({ success: false, message: "Question must be 1-500 characters." });
    if (req.body.aiConsent !== true) return res.status(400).json({ success: false, message: "Consent is required before sending location records to the assistant." });
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).lean();
    const friendIds = links.map(f => String(f.requester) === String(uid) ? f.recipient : f.requester);
    const users = await User.find({ _id: { $in: friendIds }, sharingEnabled: true }).select("_id username historyEnabled").lean();
    const names = new Map(users.map(u => [String(u._id), u.username]));
    const visibleIds = users.map(u => u._id);
    const [mine, others, visits] = await Promise.all([Location.findOne({ userId: uid }).lean(), visibleIds.length ? Location.find({ userId: { $in: visibleIds } }).lean() : [], LocationVisit.find({ userId: { $in: [uid, ...visibleIds] } }).lean()]);
    const visitByUser = new Map(visits.map(v => [String(v.userId), v]));
    const allVisibleUsers = [{ _id: uid, username: "you" }, ...users];
    const requested = requestedUsername(question, allVisibleUsers.map(u => u.username));
    const targetUser = requested ? allVisibleUsers.find(u => String(u.username).toLowerCase() === String(requested).toLowerCase()) : null;
    const ownCurrentQuestion = isOwnCurrentQuestion(question);

    if (isGeoAddressQuestion(question)) {
      const targetId = targetUser ? String(targetUser._id) : String(uid);
      const targetLocation = targetId === String(uid) ? mine : others.find(p => String(p.userId) === targetId);
      if (!targetLocation) return res.json({ success: true, answer: "I can't access a shared location for that person right now." });
      const geo = await reverseGeocode(targetLocation.latitude, targetLocation.longitude);
      const targetName = targetId === String(uid) ? "You" : (targetUser?.username || "That user");
      const parts = [geo.city, geo.state, geo.country].filter(Boolean);
      if (!parts.length) return res.json({ success: true, answer: `${targetName}'s coordinates are available, but the city/state/country could not be resolved yet.` });
      return res.json({ success: true, answer: `${targetName} is in ${geo.city || "an unknown city"}, ${geo.state || "an unknown state"}, ${geo.country || "an unknown country"}.` });
    }

    if (isCurrentQuestion(question) || ownCurrentQuestion) {
      if (ownCurrentQuestion || (targetUser && String(targetUser._id) === String(uid))) {
        if (!mine) return res.json({ success: true, answer: "I don't have your latest location. Turn on location sharing and allow location access first." });
        let visit = visitByUser.get(String(uid));
        let place = visit?.placeName;
        if (isFallbackPlace(place)) {
          place = await placeLabel(mine.latitude, mine.longitude);
          if (visit) await LocationVisit.updateOne({ _id: visit._id }, { $set: { placeName: place } });
        }
        const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(mine.lastSeen).getTime()) / 60000));
        return res.json({ success: true, answer: place && !isFallbackPlace(place) ? `You are currently at ${place}. Your location was updated ${ageMinutes} minute(s) ago.` : `I have your latest coordinates, but I don't have a resolved place name for them yet.` });
      }
      const target = targetUser && String(targetUser._id) !== String(uid) ? others.find(p => String(p.userId) === String(targetUser._id)) : null;
      if (!target) return res.json({ success: true, answer: "I can't access a current location for that person. They may not be sharing right now, or their latest location is unavailable." });
      let visit = visitByUser.get(String(target.userId));
      let place = visit?.placeName;
      if (isFallbackPlace(place)) { place = await placeLabel(target.latitude, target.longitude); if (visit) await LocationVisit.updateOne({ _id: visit._id }, { $set: { placeName: place } }); }
      const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(target.lastSeen).getTime()) / 60000));
      if (place && !isFallbackPlace(place)) return res.json({ success: true, answer: `${target.username} is currently at ${place}. Their latest location was updated ${ageMinutes} minute(s) ago.` });
      return res.json({ success: true, answer: `${target.username} is sharing a current location, but I don't have a resolved place name for it yet.` });
    }

    const distances = [];
    if (mine) for (const friend of others) {
      const km = distanceKm(mine.latitude, mine.longitude, friend.latitude, friend.longitude);
      distances.push({
        username: names.get(String(friend.userId)) || friend.username,
        distanceKm: Number(km.toFixed(2)),
        measuredAt: friend.lastSeen,
        meaning: "straight-line distance, not road distance"
      });
    }
    const context = {
      currentUserId: String(uid),
      currentUsername: req.user.username || "you",
      authorizedPeople: users.filter(user => user.historyEnabled !== false).map(user => ({
        id: String(user._id),
        username: user.username
      })),
      currentLocations: [
        ...(mine ? [{ username: "you", placeName: visitByUser.get(String(uid))?.placeName || null, lastSeen: mine.lastSeen }] : []),
        ...others.map(p => ({
          username: names.get(String(p.userId)) || p.username,
          placeName: visitByUser.get(String(p.userId))?.placeName || null,
          lastSeen: p.lastSeen
        }))
      ],
      calculatedDistances: distances
    };
    // Node remains the API/auth layer; LangChain + LangGraph RAG runs in Python.
    const me = await User.findById(uid).select("historyEnabled").lean();
    const authorizedHistoryIds = [
      ...(me?.historyEnabled !== false ? [uid] : []),
      ...users.filter(user => user.historyEnabled !== false).map(user => user._id)
    ];
    const result = await askRagService({
      question,
      userIds: authorizedHistoryIds,
      context
    });
    res.json({
      success: true,
      answer: result.answer || "I couldn't find enough information in the shared location history to answer that yet."
    });
  } catch (e) {
    console.error("Reva assistant error:", e);
    const status = [400, 401, 403, 429].includes(e.status) ? e.status : 502;
    const message = status === 400 ? e.message : "Reva couldn't answer right now. Please try again.";
    res.status(status).json({ success: false, message });
  }
};
