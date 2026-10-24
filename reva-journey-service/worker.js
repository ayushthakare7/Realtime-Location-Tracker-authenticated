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
  const overdue = await Journey.find({
    status: "ACTIVE", sharingEnabled: true, expectedArrivalAt: { $lte: now }
  }).limit(100).exec();
  let checked = 0;
  for (const journey of overdue) {
    const graceMs = Math.max(0, Number(process.env.JOURNEY_OVERDUE_GRACE_MINUTES ?? 5)) * 60_000;
    const graceEndsAt = new Date(new Date(journey.expectedArrivalAt).getTime() + graceMs);
    if (now < graceEndsAt) {
      const changed = await Journey.updateOne(
        { _id: journey._id, status: "ACTIVE", expectedArrivalAt: journey.expectedArrivalAt },
        { $set: { status: "OVERDUE_UNCONFIRMED" } }
      );
      if (changed.modifiedCount) {
        await queueNotification({ journey, recipientId: journey.travellerId, type: "journey_overdue_checkin", title: "Please check in", body: "Your expected arrival time has passed. Are you safe? A late arrival alone does not mean there is an emergency.", keySuffix: "traveller-checkin:" + journey.expectedArrivalAt.toISOString() });
        for (const recipientId of journey.sharedWith) {
          await queueNotification({ journey, recipientId, type: "journey_overdue_checkin", title: "Safety Travel check-in", body: journey.travellerUsername + " has reached their estimated arrival time. Please check in with them if needed.", keySuffix: "checkin:" + journey.expectedArrivalAt.toISOString() });
        }
        checked++;
      }
      continue;
    }
    const changed = await Journey.updateOne(
      { _id: journey._id, status: { $in: ["ACTIVE", "OVERDUE_UNCONFIRMED"] }, expectedArrivalAt: journey.expectedArrivalAt },
      { $set: { status: "ALERT_SENT" } }
    );
    if (changed.modifiedCount) {
      const fresh = await Journey.findById(journey._id).lean();
      for (const recipientId of fresh.sharedWith) {
        await queueNotification({ journey: fresh, recipientId, type: "journey_overdue_alert", title: "A friend's journey is overdue", body: fresh.travellerUsername + " has not confirmed arrival after the agreed grace period. Try contacting them; do not assume an emergency based on GPS alone.", keySuffix: "overdue:" + fresh.expectedArrivalAt.toISOString() });
      }
      checked++;
    }
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
