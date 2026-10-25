const { MobilityTrip, Location, User } = require("../models");
const { routeBetween } = require("./routing");

function distanceMeters(a, b) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

async function tick(now = new Date()) {
  const trips = await MobilityTrip.find({ status: { $in: ["ACTIVE", "DELAYED"] } }).limit(200);
  for (const trip of trips) {
    try {
      const user = await User.findById(trip.userId).lean();
      const location = await Location.findOne({ userId: trip.userId }).lean();
      if (!user || !user.sharingEnabled || !location || !location.lastSeen) continue;

      const point = { latitude: Number(location.latitude), longitude: Number(location.longitude) };
      if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) continue;
      trip.lastLocation = { ...point, lastSeen: location.lastSeen };

      const remainingMeters = distanceMeters(point, trip.destination);
      const arrivalRadius = Math.max(30, Number(process.env.MOBILITY_ARRIVAL_RADIUS_METERS) || 120);
      const neededReadings = Math.max(2, Number(process.env.MOBILITY_ARRIVAL_CONFIRMATIONS) || 2);
      trip.nearDestinationCount = remainingMeters <= arrivalRadius ? trip.nearDestinationCount + 1 : 0;
      if (trip.nearDestinationCount >= neededReadings) {
        trip.status = "ARRIVED";
        trip.arrivedAt = now;
        trip.endedAt = now;
        await trip.save();
        continue;
      }

      const movedMeters = distanceMeters(trip.lastRoutedFrom, point);
      const routeAgeMs = now.getTime() - new Date(trip.lastRouteRefreshAt).getTime();
      const refreshAfterMeters = Math.max(100, Number(process.env.MOBILITY_RECALCULATE_AFTER_METERS) || 300);
      if (movedMeters >= refreshAfterMeters || routeAgeMs >= 5 * 60 * 1000) {
        try {
          const route = await routeBetween(point, trip.destination, trip.transportMode);
          trip.route = route;
          trip.lastRoutedFrom = point;
          trip.lastRouteRefreshAt = now;
          trip.expectedArrivalAt = new Date(now.getTime() + route.durationSeconds * 1000);
          trip.lastRouteErrorAt = null;
          trip.status = trip.expectedArrivalAt.getTime() > new Date(trip.originalExpectedArrivalAt).getTime() + (Number(trip.gracePeriodMinutes) || 8) * 60000
            ? "DELAYED" : "ACTIVE";
        } catch (error) {
          trip.lastRouteErrorAt = now;
          console.warn("[MobilityWorker] Route refresh skipped:", error.message);
        }
      }

      if (trip.expectedArrivalAt && now.getTime() > new Date(trip.expectedArrivalAt).getTime() + (Number(trip.gracePeriodMinutes) || 8) * 60000) {
        trip.status = "DELAYED";
      }
      await trip.save();
    } catch (error) {
      console.error("[MobilityWorker] Trip processing failed:", String(trip._id), error.message);
    }
  }
}

function startMobilityWorker() {
  let running = false;
  const interval = Math.max(30000, Number(process.env.MOBILITY_WORKER_INTERVAL_MS) || 60000);
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(); }
    catch (error) { console.error("[MobilityWorker] Tick failed:", error.message); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(run, interval);
  timer.unref?.();
  console.log("[MobilityWorker] Polling every " + interval + "ms");
  return () => clearInterval(timer);
}

module.exports = { tick, startMobilityWorker, distanceMeters };
