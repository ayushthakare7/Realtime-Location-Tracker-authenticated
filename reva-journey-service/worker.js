const Journey = require("./models/Journey");
const Notification = require("./models/Notification");

async function queueNotification({ journey, recipientId, type, title, body, keySuffix }) {
  const key = String(journey._id) + ":" + recipientId + ":" + keySuffix;
  try {
    await Notification.create({
      key, recipientId, journeyId: String(journey._id), type, title, body,
      payload: { journeyId: String(journey._id), status: journey.status, expectedArrivalAt: journey.expectedArrivalAt }
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

async function checkOverdueJourneys(now = new Date()) {
  const graceMs = Math.max(0, Number(process.env.JOURNEY_OVERDUE_GRACE_MINUTES ?? 5)) * 60_000;
  const candidates = await Journey.find({
    status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED"] },
    sharingEnabled: true,
    expectedArrivalAt: { $ne: null, $lte: now }
  }).limit(100).exec();
  let checked = 0;

  for (const candidate of candidates) {
    const eta = new Date(candidate.expectedArrivalAt);
    const graceEndsAt = new Date(eta.getTime() + graceMs);

    if (candidate.status === "ACTIVE" && now < graceEndsAt) {
      const changed = await Journey.updateOne(
        { _id: candidate._id, status: "ACTIVE", expectedArrivalAt: candidate.expectedArrivalAt, sharingEnabled: true },
        { $set: { status: "OVERDUE_UNCONFIRMED" } }
      );
      if (!changed.modifiedCount) continue;
      const journey = await Journey.findById(candidate._id).lean();
      await queueNotification({
        journey, recipientId: journey.travellerId, type: "journey_overdue_checkin",
        title: "Please check in",
        body: "Your expected arrival time has passed. Are you safe? A late arrival alone does not mean there is an emergency.",
        keySuffix: "traveller-checkin:" + eta.toISOString()
      });
      for (const recipientId of journey.sharedWith) {
        await queueNotification({
          journey, recipientId, type: "journey_overdue_checkin", title: "Safety Travel check-in",
          body: journey.travellerUsername + " has reached their estimated arrival time. Please check in with them if needed.",
          keySuffix: "checkin:" + eta.toISOString()
        });
      }
      checked++;
      continue;
    }

    if (now < graceEndsAt) continue;
    const changed = await Journey.updateOne(
      { _id: candidate._id, status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED"] }, expectedArrivalAt: candidate.expectedArrivalAt, sharingEnabled: true },
      { $set: { status: "ALERT_SENT" } }
    );
    if (!changed.modifiedCount) continue;
    const journey = await Journey.findById(candidate._id).lean();
    for (const recipientId of journey.sharedWith) {
      await queueNotification({
        journey, recipientId, type: "journey_overdue_alert", title: "A friend's journey is overdue",
        body: journey.travellerUsername + " has not confirmed arrival after the agreed grace period. Try contacting them; do not assume an emergency based on GPS alone.",
        keySuffix: "overdue:" + eta.toISOString()
      });
    }
    checked++;
  }
  return { checked };
}

function startWorker() {
  const intervalMs = Math.max(15_000, Number(process.env.JOURNEY_WORKER_INTERVAL_MS || 30_000));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await checkOverdueJourneys(); }
    catch (error) { console.error("[reva-journey-service] overdue monitor failed:", error.message); }
    finally { busy = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
module.exports = { checkOverdueJourneys, queueNotification, startWorker };
