// Friendship management and location-sharing controls.
const User = require("../models/User");
const Location = require("../models/Location");
const LocationVisit = require("../models/LocationVisit");
const Friendship = require("../models/Friendship");
const SafetyJourney = require("../models/SafetyJourney");
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
exports.listFriends = async (req, res) => {
  try {
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).populate("requester", "username sharingEnabled avatarId profileImage").populate("recipient", "username sharingEnabled avatarId profileImage");
    const friends = await Promise.all(links.map(async f => {
      const u = String(f.requester._id) === String(uid) ? f.recipient : f.requester;
      const [loc, visit] = u.sharingEnabled ? await Promise.all([Location.findOne({ userId: u._id }).lean(), LocationVisit.findOne({ userId: u._id }).lean()]) : [null, null];
      return { id: String(u._id), username: u.username, avatarId: u.avatarId || "college-boy", profileImage: u.profileImage || "", sharingEnabled: Boolean(u.sharingEnabled), location: loc ? { latitude: loc.latitude, longitude: loc.longitude, lastSeen: loc.lastSeen, placeName: visit?.placeName || null } : null };
    }));
    const requests = await Friendship.find({ recipient: uid, status: "pending" }).populate("requester", "username");
    const me = await User.findById(uid).select("sharingEnabled historyEnabled avatarId profileImage");
    res.json({ success: true, friends, requests: requests.map(f => ({ id: String(f._id), username: f.requester.username })), sharingEnabled: Boolean(me && me.sharingEnabled), historyEnabled: me?.historyEnabled !== false, profile: { avatarId: me?.avatarId || "college-boy", profileImage: me?.profileImage || "" } });
  } catch { res.status(500).json({ success: false, message: "Could not load friends." }); }
};
