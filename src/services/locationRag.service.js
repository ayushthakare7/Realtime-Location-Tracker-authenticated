const LocationEvent = require("../models/LocationEvent");

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "to", "at", "in", "on", "of", "for", "me", "my", "i", "we", "you", "did", "do", "does", "how", "many", "what", "where", "when", "from", "with", "and", "or", "km", "kilometer", "kilometers"]);

function terms(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 1 && !STOP_WORDS.has(word)) || [];
}

// Retrieve event documents, not raw GPS samples. Authorization filters are supplied by the controller.
async function retrieveLocationEvents({ userIds, question, limit = 12 }) {
  if (!userIds || !userIds.length) return [];
  const events = await LocationEvent.find({
    userId: { $in: userIds },
    eventType: { $in: ["arrival", "stay", "departure"] }
  }).sort({ recordedAt: -1 }).limit(300).lean();

  const queryTerms = [...new Set(terms(question))];
  const ranked = events.map(event => {
    const content = `${event.username} ${event.eventType} ${event.placeName} ${event.summary}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) if (content.includes(term)) score += term.length > 4 ? 2 : 1;
    const ageHours = Math.max(0, (Date.now() - new Date(event.recordedAt).getTime()) / 3600000);
    score += 1 / (1 + ageHours / 24);
    return { event, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(({ event }) => ({
    username: event.username,
    eventType: event.eventType,
    placeName: event.placeName,
    summary: event.summary,
    startAt: event.startAt,
    endAt: event.endAt,
    durationMinutes: event.durationMinutes,
    recordedAt: event.recordedAt
  }));
}

module.exports = { retrieveLocationEvents };
