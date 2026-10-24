(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RevaJourneyOfflineQueue = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DB_NAME = "reva-safety-travel";
  const STORE_NAME = "journey-events";
  const MAX_EVENTS = 2000;
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const BATCH_SIZE = 100;

  function createBrowserStore() {
    function openDb() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is unavailable."));
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "eventId" });
            store.createIndex("journeyId", "journeyId", { unique: false });
            store.createIndex("recordedAt", "recordedAt", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open local journey storage."));
      });
    }
    async function transaction(mode, operation) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        let result;
        try { result = operation(store); } catch (error) { db.close(); reject(error); return; }
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error("Local journey storage failed.")); };
      });
    }
    return {
      async all() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, "readonly");
          const request = tx.objectStore(STORE_NAME).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error || new Error("Could not read queued journey events."));
          tx.oncomplete = () => db.close();
          tx.onerror = () => { db.close(); reject(tx.error || new Error("Could not read queued journey events.")); };
        });
      },
      async putMany(events) {
        return transaction("readwrite", store => { events.forEach(event => store.put(event)); });
      },
      async deleteMany(ids) {
        return transaction("readwrite", store => { ids.forEach(id => store.delete(id)); });
      },
      async clearExpired(cutoff) {
        const events = await this.all();
        const expired = events.filter(event => Date.parse(event.recordedAt) < cutoff).map(event => event.eventId);
        if (expired.length) await this.deleteMany(expired);
        return expired.length;
      }
    };
  }

  function createJourneyOfflineQueue(options) {
    const store = options.store;
    const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const getToken = options.getToken || (() => typeof localStorage !== "undefined" ? localStorage.getItem("token") : null);
    const isOnline = options.isOnline || (() => typeof navigator === "undefined" || navigator.onLine !== false);
    const now = options.now || (() => Date.now());
    if (!store) throw new Error("A persistent queue store is required.");

    let flushing = false;
    let lastError = null;
    let syncedCount = 0;

    async function prune() {
      if (typeof store.clearExpired === "function") await store.clearExpired(now() - MAX_AGE_MS);
      const events = (await store.all()).sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
      if (events.length > MAX_EVENTS) await store.deleteMany(events.slice(0, events.length - MAX_EVENTS).map(event => event.eventId));
    }

    async function enqueue(journeyId, event) {
      if (!/^[a-f\d]{24}$/i.test(String(journeyId || ""))) throw new Error("A valid active journey ID is required to queue progress.");
      if (!event || !["location", "check_in", "arrival", "offline", "online", "emergency"].includes(event.type)) throw new Error("Unsupported journey event type.");
      const recordedAt = event.recordedAt || new Date(now()).toISOString();
      if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(recordedAt) > now() + 5 * 60 * 1000 || Date.parse(recordedAt) < now() - MAX_AGE_MS) throw new Error("Journey event timestamp is outside the accepted seven-day window.");
      if (event.type === "location" && (!Number.isFinite(Number(event.latitude)) || Number(event.latitude) < -90 || Number(event.latitude) > 90 || !Number.isFinite(Number(event.longitude)) || Number(event.longitude) < -180 || Number(event.longitude) > 180)) throw new Error("Valid GPS coordinates are required.");
      const queued = {
        eventId: String(event.eventId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "reva-" + now() + "-" + Math.random().toString(16).slice(2))),
        journeyId: String(journeyId),
        type: event.type,
        recordedAt: new Date(recordedAt).toISOString()
      };
      if (event.type === "location") {
        queued.latitude = Number(event.latitude);
        queued.longitude = Number(event.longitude);
        if (event.accuracyMeters != null && Number.isFinite(Number(event.accuracyMeters))) queued.accuracyMeters = Number(event.accuracyMeters);
      }
      if (event.note != null) queued.note = String(event.note).slice(0, 500);
      await store.putMany([queued]);
      await prune();
      if (isOnline()) flush().catch(() => {});
      return queued.eventId;
    }

    async function flush() {
      if (flushing || !isOnline()) return { syncedCount: 0, pendingCount: (await store.all()).length, offline: !isOnline() };
      if (!fetchImpl) throw new Error("Network requests are unavailable.");
      const token = getToken();
      if (!token) {
        lastError = "Sign in to sync saved journey updates.";
        return { syncedCount: 0, pendingCount: (await store.all()).length, error: lastError };
      }
      flushing = true;
      let newlySynced = 0;
      try {
        await prune();
        let events = await store.all();
        events.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
        const journeyIds = [...new Set(events.map(event => event.journeyId))];
        for (const journeyId of journeyIds) {
          if (!isOnline()) break;
          const journeyEvents = events.filter(event => event.journeyId === journeyId);
          for (let offset = 0; offset < journeyEvents.length; offset += BATCH_SIZE) {
            if (!isOnline()) break;
            const batch = journeyEvents.slice(offset, offset + BATCH_SIZE);
            const response = await fetchImpl("/api/journeys/" + encodeURIComponent(journeyId) + "/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
              body: JSON.stringify({ events: batch.map(({ journeyId: ignored, ...event }) => event) })
            });
            let body = {};
            try { body = await response.json(); } catch (_) {}
            if (response.status === 409) {
              // The server says this journey no longer accepts events. Keep the
              // queue visible for recovery instead of silently deleting data.
              lastError = body.message || "This journey has ended; saved updates need review.";
              return { syncedCount: newlySynced, pendingCount: (await store.all()).length, error: lastError };
            }
            if (!response.ok || body.success !== true) {
              lastError = body.message || "Journey sync failed; updates remain saved on this device.";
              return { syncedCount: newlySynced, pendingCount: (await store.all()).length, error: lastError, status: response.status };
            }
            await store.deleteMany(batch.map(event => event.eventId));
            newlySynced += batch.length;
            syncedCount += batch.length;
          }
          events = await store.all();
        }
        lastError = null;
        return { syncedCount: newlySynced, pendingCount: (await store.all()).length, error: null };
      } catch (error) {
        lastError = error && error.message ? error.message : "Journey sync failed; updates remain saved on this device.";
        return { syncedCount: newlySynced, pendingCount: (await store.all()).length, error: lastError };
      } finally {
        flushing = false;
      }
    }

    async function status() {
      return { pendingCount: (await store.all()).length, offline: !isOnline(), lastError, syncedCount };
    }

    return { enqueue, flush, status };
  }

  return { BATCH_SIZE, MAX_AGE_MS, MAX_EVENTS, createBrowserStore, createJourneyOfflineQueue };
});
