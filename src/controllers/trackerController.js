const User = require("../models/User");
const Location = require("../models/Location");
const LocationEvent = require("../models/LocationEvent");
const Friendship = require("../models/Friendship");
const { askGemini } = require("../services/gemini.service");

exports.setSharing = async (req, res) => {
  try {
    const enabled = req.body.enabled === true;
    await User.findByIdAndUpdate(req.user.userId, { sharingEnabled: enabled });
    if (!enabled) { await Location.deleteOne({ userId: req.user.userId }); await LocationEvent.deleteMany({ userId: req.user.userId }); }
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
    request.status = req.body.status; await request.save();
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
  try {
    const question = String(req.body.question || "").trim();
    if (!question || question.length > 500) return res.status(400).json({ success: false, message: "Question must be 1-500 characters." });
    const uid = req.user.userId;
    const links = await Friendship.find({ status: "accepted", $or: [{ requester: uid }, { recipient: uid }] }).lean();
    const ids = links.map(f => String(f.requester) === String(uid) ? f.recipient : f.requester);
    const users = await User.find({ _id: { $in: ids }, sharingEnabled: true }).select("_id username").lean();
    const names = new Map(users.map(u => [String(u._id), u.username]));
    const visibleIds = users.map(u => u._id);
    const [mine, others, history] = await Promise.all([
      Location.findOne({ userId: uid }).lean(),
      visibleIds.length ? Location.find({ userId: { $in: visibleIds } }).lean() : [],
      LocationEvent.find({ $or: [{ userId: uid }, { userId: { $in: visibleIds } }] }).sort({ recordedAt: -1 }).limit(20).lean()
    ]);
    const records = [];
    if (mine) records.push({ owner: "you", latitude: mine.latitude, longitude: mine.longitude, at: mine.lastSeen });
    for (const p of others) records.push({ owner: names.get(String(p.userId)), latitude: p.latitude, longitude: p.longitude, at: p.lastSeen });
    for (const p of history) records.push({ owner: String(p.userId) === String(uid) ? "you" : names.get(String(p.userId)), latitude: p.latitude, longitude: p.longitude, at: p.recordedAt });
    const prompt = "Answer the question only from this retrieved JSON. Do not infer addresses or routes from coordinates. Note missing or stale information.\nDATA=" + JSON.stringify(records) + "\nQUESTION=" + question;
    const answer = await askGemini(prompt);
    res.json({ success: true, answer: answer || "No answer from available records." });
  } catch (e) {
    res.status(e.status === 429 ? 429 : 502).json({ success: false, message: "Ask My Map failed. Check Gemini API key and quota." });
  }
};
