const User = require("../models/User");
const Location = require("../models/Location");
const Friendship = require("../models/Friendship");

exports.setSharing = async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    await User.findByIdAndUpdate(req.user.userId, { sharingEnabled: enabled });
    if (!enabled) await Location.deleteOne({ userId: req.user.userId });
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

exports.listFriends = async (req, res) => {
  try {
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).populate("requester", "username sharingEnabled").populate("recipient", "username sharingEnabled");
    const friends = await Promise.all(links.map(async f => {
      const u = String(f.requester._id) === String(uid) ? f.recipient : f.requester;
      const loc = u.sharingEnabled ? await Location.findOne({ userId: u._id }).lean() : null;
      return { id: String(u._id), username: u.username, sharingEnabled: Boolean(u.sharingEnabled), location: loc ? { latitude: loc.latitude, longitude: loc.longitude, lastSeen: loc.lastSeen } : null };
    }));
    const requests = await Friendship.find({ recipient: uid, status: "pending" }).populate("requester", "username");
    const me = await User.findById(uid).select("sharingEnabled");
    res.json({ success: true, friends, requests: requests.map(f => ({ id: String(f._id), username: f.requester.username })), sharingEnabled: Boolean(me && me.sharingEnabled) });
  } catch { res.status(500).json({ success: false, message: "Could not load friends." }); }
};

exports.askMap = async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, message: "Configure GEMINI_API_KEY in .env." });
  return res.status(501).json({ success: false, message: "Ask My Map is being configured." });
};
