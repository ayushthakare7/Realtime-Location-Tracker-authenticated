const mongoose = require("mongoose");
const LocationEvent = require("../models/LocationEvent");
const { embedText } = require("./embedding.service");

const VECTOR_INDEX = process.env.RAG_VECTOR_INDEX || "location_event_vector_index";

function cleanEvent(event) {
  return {
    id: String(event._id),
    username: event.username,
    eventType: event.eventType,
    placeName: event.placeName,
    summary: event.summary,
    startAt: event.startAt,
    endAt: event.endAt,
    durationMinutes: event.durationMinutes,
    recordedAt: event.recordedAt,
    similarity: event.similarity == null ? undefined : Number(Number(event.similarity).toFixed(4))
  };
}

function timeRange(question) {
  const q = question.toLowerCase();
  const now = new Date();
  if (/\byesterday\b/.test(q)) {
    const end = new Date(now); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 1);
    return { start, end };
  }
  if (/\btoday\b/.test(q) || /\btonight\b/.test(q)) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    return { start, end: now };
  }
  if (/\bthis week\b/.test(q)) {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const day = start.getDay();
    start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
    return { start, end: now };
  }
  return null;
}

async function vectorRetrieve({ userIds, question, limit = 12 }) {
  const queryEmbedding = await embedText(question);
  const filter = {
    userId: { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
    embedding: { $exists: true }
  };
  const range = timeRange(question);
  if (range) filter.recordedAt = { $gte: range.start, $lte: range.end };

  const results = await LocationEvent.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: Math.max(100, limit * 20),
        limit,
        filter
      }
    },
    {
      $project: {
        username: 1,
        eventType: 1,
        placeName: 1,
        summary: 1,
        startAt: 1,
        endAt: 1,
        durationMinutes: 1,
        recordedAt: 1,
        similarity: { $meta: "vectorSearchScore" }
      }
    }
  ]);
  return results.map(cleanEvent);
}

// Authorization is deliberately performed by the controller before this function receives userIds.
// Vector search then pre-filters by those authorized user IDs, so private events never enter retrieval.
async function retrieveLocationEvents({ userIds, question, limit = 12 }) {
  if (!userIds?.length) return [];
  try {
    return await vectorRetrieve({ userIds, question, limit });
  } catch (error) {
    // If Atlas vector search is not configured yet, keep the application usable while setup is completed.
    // This fallback is lexical only and is not the primary RAG path.
    console.error("Vector retrieval unavailable:", error.message);
    const queryTerms = [...new Set(String(question).toLowerCase().match(/[a-z0-9]+/g) || [])].filter(word => word.length > 2);
    const events = await LocationEvent.find({ userId: { $in: userIds }, eventType: { $in: ["arrival", "stay", "departure"] } })
      .sort({ recordedAt: -1 }).limit(300).lean();
    return events.map(event => {
      const content = `${event.username} ${event.eventType} ${event.placeName} ${event.summary}`.toLowerCase();
      const score = queryTerms.reduce((total, term) => total + (content.includes(term) ? 1 : 0), 0);
      return { event, score };
    }).sort((a, b) => b.score - a.score || new Date(b.event.recordedAt) - new Date(a.event.recordedAt))
      .slice(0, limit).map(({ event }) => cleanEvent(event));
  }
}

module.exports = { retrieveLocationEvents, timeRange, VECTOR_INDEX };
