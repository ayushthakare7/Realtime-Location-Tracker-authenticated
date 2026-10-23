const mongoose = require("mongoose");
const LocationEvent = require("../models/LocationEvent");
const { timeRange } = require("./locationRag.service");

function normalizePlace(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function minutesOverlap(a, b) {
  const start = Math.max(new Date(a.startAt).getTime(), new Date(b.startAt).getTime());
  const end = Math.min(new Date(a.endAt).getTime(), new Date(b.endAt).getTime());
  return Math.max(0, Math.round((end - start) / 60000));
}

function compactEvent(event) {
  return {
    username: event.username,
    eventType: event.eventType,
    placeName: event.placeName,
    startAt: event.startAt,
    endAt: event.endAt,
    durationMinutes: event.durationMinutes || 0
  };
}

function buildTransitions(events) {
  const byUser = new Map();
  for (const event of events) {
    const key = String(event.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(event);
  }

  const transitions = [];
  for (const userEvents of byUser.values()) {
    userEvents.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    for (let i = 1; i < userEvents.length; i += 1) {
      const from = userEvents[i - 1];
      const to = userEvents[i];
      if (normalizePlace(from.placeName) === normalizePlace(to.placeName)) continue;
      transitions.push({
        username: to.username,
        from: from.placeName,
        to: to.placeName,
        departedAt: from.endAt,
        arrivedAt: to.startAt
      });
    }
  }
  return transitions.sort((a, b) => new Date(b.arrivedAt) - new Date(a.arrivedAt)).slice(0, 30);
}

function buildTopPlaces(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${String(event.userId)}::${normalizePlace(event.placeName)}`;
    const existing = groups.get(key) || {
      username: event.username,
      placeName: event.placeName,
      visits: 0,
      durationMinutes: 0,
      lastVisitedAt: event.startAt
    };
    existing.visits += 1;
    existing.durationMinutes += Number(event.durationMinutes || 0);
    if (new Date(event.startAt) > new Date(existing.lastVisitedAt)) existing.lastVisitedAt = event.startAt;
    groups.set(key, existing);
  }
  return [...groups.values()]
    .sort((a, b) => b.visits - a.visits || b.durationMinutes - a.durationMinutes)
    .slice(0, 20)
    .map(item => ({ ...item, durationMinutes: Math.round(item.durationMinutes) }));
}

function buildSharedPresence(events) {
  const overlaps = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if (String(a.userId) === String(b.userId)) continue;
      if (normalizePlace(a.placeName) !== normalizePlace(b.placeName)) continue;
      const overlap = minutesOverlap(a, b);
      if (overlap < 10) continue;
      overlaps.push({
        people: [a.username, b.username].sort(),
        placeName: a.placeName,
        overlapMinutes: overlap,
        from: new Date(Math.max(new Date(a.startAt).getTime(), new Date(b.startAt).getTime())).toISOString(),
        to: new Date(Math.min(new Date(a.endAt).getTime(), new Date(b.endAt).getTime())).toISOString()
      });
    }
  }
  return overlaps
    .sort((a, b) => b.overlapMinutes - a.overlapMinutes)
    .slice(0, 15);
}

async function buildLocationInsights({ userIds, question }) {
  if (!userIds?.length) return { topPlaces: [], transitions: [], sharedPresence: [] };

  const filter = {
    userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
    eventType: { $in: ["arrival", "stay", "departure"] }
  };
  const range = timeRange(question);
  if (range) filter.recordedAt = { $gte: range.start, $lte: range.end };

  const events = await LocationEvent.find(filter)
    .select("userId username eventType placeName startAt endAt durationMinutes")
    .sort({ startAt: -1 })
    .limit(500)
    .lean();

  return {
    eventCountAnalyzed: events.length,
    topPlaces: buildTopPlaces(events),
    transitions: buildTransitions(events),
    sharedPresence: buildSharedPresence(events),
    recentTimeline: events.slice(0, 25).map(compactEvent)
  };
}

module.exports = { buildLocationInsights };