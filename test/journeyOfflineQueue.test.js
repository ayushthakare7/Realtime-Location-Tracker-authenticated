const test = require("node:test");
const assert = require("node:assert/strict");
const { createJourneyOfflineQueue } = require("../src/public/js/journey-offline-queue");

const JOURNEY_ID = "507f1f77bcf86cd799439011";

function makeStore() {
  const events = new Map();
  return {
    async all() { return [...events.values()]; },
    async putMany(items) { for (const item of items) events.set(item.eventId, structuredClone(item)); },
    async deleteMany(ids) { for (const id of ids) events.delete(id); },
    async clearExpired(cutoff) {
      let removed = 0;
      for (const [id, event] of events) {
        if (Date.parse(event.recordedAt) < cutoff) { events.delete(id); removed += 1; }
      }
      return removed;
    }
  };
}

test("queues location updates locally while offline and syncs them after reconnection", async () => {
  const store = makeStore();
  let online = false;
  const requests = [];
  const queue = createJourneyOfflineQueue({
    store,
    isOnline: () => online,
    getToken: () => "test-token",
    now: () => Date.parse("2026-10-25T10:00:00.000Z"),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true, acceptedCount: 1 }) };
    }
  });

  await queue.enqueue(JOURNEY_ID, {
    eventId: "offline-location-1", type: "location",
    latitude: 21.1904, longitude: 81.2849,
    recordedAt: "2026-10-25T09:59:00.000Z"
  });
  assert.equal((await queue.status()).pendingCount, 1);
  assert.equal(requests.length, 0);

  online = true;
  const result = await queue.flush();
  assert.equal(result.syncedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/journeys\/.+\/sync$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.events[0].latitude, 21.1904);
  assert.equal("journeyId" in body.events[0], false);
});

test("retains queued events when the server fails and does not duplicate a concurrent flush", async () => {
  const store = makeStore();
  let online = false;
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const queue = createJourneyOfflineQueue({
    store,
    isOnline: () => online,
    getToken: () => "test-token",
    now: () => Date.parse("2026-10-25T10:00:00.000Z"),
    fetchImpl: async () => {
      calls += 1;
      await blocked;
      return { ok: false, status: 503, json: async () => ({ success: false, message: "Temporary failure" }) };
    }
  });
  await queue.enqueue(JOURNEY_ID, {
    eventId: "offline-location-2", type: "location",
    latitude: 21.1904, longitude: 81.2849,
    recordedAt: "2026-10-25T09:59:00.000Z"
  });
  online = true;
  const first = queue.flush();
  await new Promise(resolve => setImmediate(resolve));
  const second = await queue.flush();
  assert.equal(calls, 1);
  assert.equal(second.pendingCount, 1);
  release();
  const result = await first;
  assert.equal(result.pendingCount, 1);
  assert.equal(result.error, "Temporary failure");
});

test("validates journey identifiers and GPS coordinates before storing", async () => {
  const queue = createJourneyOfflineQueue({
    store: makeStore(),
    isOnline: () => false,
    now: () => Date.parse("2026-10-25T10:00:00.000Z")
  });
  await assert.rejects(() => queue.enqueue("bad-id", { type: "offline" }), /valid active journey ID/);
  await assert.rejects(() => queue.enqueue(JOURNEY_ID, {
    eventId: "bad-coordinate", type: "location", latitude: 500, longitude: 0,
    recordedAt: "2026-10-25T09:59:00.000Z"
  }), /Valid GPS coordinates/);
  assert.equal((await queue.status()).pendingCount, 0);
});

test("keeps events for separate journeys in separate sync requests", async () => {
  const store = makeStore();
  let online = false;
  const calls = [];
  const queue = createJourneyOfflineQueue({
    store,
    isOnline: () => online,
    getToken: () => "test-token",
    now: () => Date.parse("2026-10-25T10:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ success: true, acceptedCount: 1 }) };
    }
  });
  await queue.enqueue(JOURNEY_ID, { eventId: "journey-a", type: "offline", recordedAt: "2026-10-25T09:59:00.000Z" });
  await queue.enqueue("507f1f77bcf86cd799439012", { eventId: "journey-b", type: "offline", recordedAt: "2026-10-25T09:59:01.000Z" });
  assert.equal((await queue.status()).pendingCount, 2);
  online = true;
  const result = await queue.flush();
  assert.equal(result.pendingCount, 0);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].url, calls[1].url);
  assert.equal(calls[0].body.events.length, 1);
  assert.equal(calls[1].body.events.length, 1);
});
