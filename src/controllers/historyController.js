// User-controlled location-history settings and history retrieval/deletion.
const User = require("../models/User");
const LocationPoint = require("../models/LocationPoint");
const LocationVisit = require("../models/LocationVisit");
const LocationEvent = require("../models/LocationEvent");
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
