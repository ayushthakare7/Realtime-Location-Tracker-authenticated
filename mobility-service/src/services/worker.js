const { MobilityTrip, Location, User } = require("../models");
const { routeBetween } = require("./routing");
const { emitMobilityEvent } = require("./notifications");
const { distanceMeters } = require("./geo");
async function tick(now = new Date()) {
  const trips = await MobilityTrip.find({ status: { $in: ["ACTIVE", "DELAYED"] } }).limit(200);
  for (const trip of trips) {
    try {
      const [user, location] = await Promise.all([User.findById(trip.userId).lean(), Location.findOne({ userId: trip.userId }).lean()]);
      if (!user || !user.sharingEnabled) {
        trip.status = "CANCELLED"; trip.endedAt = now;
        await trip.save(); await emitMobilityEvent(trip, "journey_ended");
        continue;
      }
      if (!location || !location.lastSeen) continue;
      const point = { latitude: Number(location.latitude), longitude: Number(location.longitude) };
      if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
      trip.lastLocation = { ...point, lastSeen: location.lastSeen };
      const remainingMeters = distanceMeters(point, trip.destination);
      const radius = Math.max(30, Number(process.env.MOBILITY_ARRIVAL_RADIUS_METERS) || 150);
      const confirmations = Math.max(2, Number(process.env.MOBILITY_ARRIVAL_CONFIRMATIONS) || 2);
      const gpsAge = now.getTime() - new Date(location.lastSeen).getTime();
      const fresh = gpsAge >= 0 && gpsAge <= 120000;
      const maxArrivalAccuracy = Math.max(20, Number(process.env.MOBILITY_MAX_ARRIVAL_ACCURACY_METERS) || 80);
      const accurateEnough = location.accuracyMeters !== null && location.accuracyMeters !== undefined && Number.isFinite(Number(location.accuracyMeters)) && Number(location.accuracyMeters) <= maxArrivalAccuracy;
      const newSample = !trip.lastArrivalSampleAt || new Date(location.lastSeen).getTime() > new Date(trip.lastArrivalSampleAt).getTime();
      if (fresh && accurateEnough && newSample) {
        trip.nearDestinationCount = remainingMeters <= radius ? trip.nearDestinationCount + 1 : 0;
        trip.lastArrivalSampleAt = location.lastSeen;
      } else if (fresh && newSample) {
        trip.nearDestinationCount = 0;
        trip.lastArrivalSampleAt = location.lastSeen;
      }
      if (trip.nearDestinationCount >= confirmations && fresh && accurateEnough) {
        trip.status = "ARRIVED"; trip.arrivedAt = now; trip.endedAt = now;
        await trip.save(); await emitMobilityEvent(trip, "journey_arrived"); continue;
      }
      if (!fresh) {
        const previousStatus = trip.status;
        if (now.getTime() > new Date(trip.expectedArrivalAt).getTime() + (Number(trip.gracePeriodMinutes) || 8) * 60000) trip.status = "DELAYED";
        await trip.save();
        if (previousStatus !== "DELAYED" && trip.status === "DELAYED" && !trip.delayNotifiedAt) {
          trip.delayNotifiedAt = now; await trip.save(); await emitMobilityEvent(trip, "journey_delayed");
        }
        continue;
      }

      const previousStatus = trip.status;
      const moved = distanceMeters(trip.lastRoutedFrom, point);
      const routeAge = now.getTime() - new Date(trip.lastRouteRefreshAt).getTime();
      if (moved >= Math.max(300, Number(process.env.MOBILITY_RECALCULATE_AFTER_METERS) || 1000) || (routeAge >= 600000 && moved >= 300)) {
        try {
          const route = await routeBetween(point, trip.destination, trip.transportMode);
          trip.route = route; trip.lastRoutedFrom = point; trip.lastRouteRefreshAt = now;
          trip.expectedArrivalAt = new Date(now.getTime() + route.durationSeconds * 1000); trip.lastRouteErrorAt = null;
        } catch (error) { trip.lastRouteErrorAt = now; console.warn("[MobilityWorker] Route refresh skipped:", error.message); }
      }
      const graceMs = (Number(trip.gracePeriodMinutes) || 8) * 60000;
      const pushedBeyondOriginal = new Date(trip.expectedArrivalAt).getTime() > new Date(trip.originalExpectedArrivalAt).getTime() + graceMs;
      const latestEtaPassed = now.getTime() > new Date(trip.expectedArrivalAt).getTime() + graceMs;
      trip.status = (trip.status === "DELAYED" || pushedBeyondOriginal || latestEtaPassed) ? "DELAYED" : "ACTIVE";
      await trip.save();
      if (previousStatus !== "DELAYED" && trip.status === "DELAYED" && !trip.delayNotifiedAt) {
        trip.delayNotifiedAt = now; await trip.save(); await emitMobilityEvent(trip, "journey_delayed");
      }
    } catch (error) { console.error("[MobilityWorker] Trip processing failed:", String(trip._id), error.message); }
  }
}
function startMobilityWorker() {
  let running = false;
  const interval = Math.max(30000, Number(process.env.MOBILITY_WORKER_INTERVAL_MS) || 30000);
  const run = async () => { if (running) return; running = true; try { await tick(); } catch (error) { console.error("[MobilityWorker] Tick failed:", error.message); } finally { running = false; } };
  void run(); const timer = setInterval(run, interval); timer.unref?.();
  console.log("[MobilityWorker] Polling every " + interval + "ms"); return () => clearInterval(timer);
}
module.exports = { tick, startMobilityWorker, distanceMeters };
