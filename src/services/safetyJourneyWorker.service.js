const SafetyJourney = require("../models/SafetyJourney");
const { notifyJourneyRecipients } = require("./safetyNotification.service");

const CHECK_IN_GRACE_MINUTES = Number.isInteger(Number(process.env.JOURNEY_CHECKIN_GRACE_MINUTES))
  ? Math.min(60, Math.max(1, Number(process.env.JOURNEY_CHECKIN_GRACE_MINUTES)))
  : 5;
const POLL_INTERVAL_MS = Math.max(10000, Number(process.env.JOURNEY_WORKER_INTERVAL_MS) || 30000);

async function processSafetyDeadlines(io, now = new Date()) {
  const active = await SafetyJourney.find({
    status: "ACTIVE",
    sharingEnabled: true,
    expectedArrivalAt: { $ne: null, $lte: now }
  }).limit(500);

  for (const candidate of active) {
    const deadline = new Date(candidate.expectedArrivalAt).getTime() + Number(candidate.gracePeriodMinutes || 0) * 60000;
    if (deadline > now.getTime()) continue;
    const journey = await SafetyJourney.findOneAndUpdate(
      { _id: candidate._id, status: "ACTIVE", sharingEnabled: true },
      { $set: { status: "OVERDUE_UNCONFIRMED", checkInRequestedAt: now } },
      { new: true }
    );
    if (!journey) continue;
    await notifyJourneyRecipients({
      io,
      journey,
      recipients: [journey.travellerId],
      type: "journey_overdue_checkin",
      title: "Please check in",
      body: "Your expected arrival time has passed. Are you safe? A late arrival alone does not mean there is an emergency.",
      payload: { journeyId: String(journey._id), status: journey.status },
      keySuffix: "overdue-checkin"
    });
    io?.to("user:" + journey.travellerId).emit("journey-checkin-request", {
      journeyId: String(journey._id),
      expectedArrivalAt: journey.expectedArrivalAt,
      gracePeriodMinutes: journey.gracePeriodMinutes
    });
  }

  const cutoff = new Date(now.getTime() - CHECK_IN_GRACE_MINUTES * 60000);
  const awaiting = await SafetyJourney.find({
    status: "OVERDUE_UNCONFIRMED",
    sharingEnabled: true,
    checkInRequestedAt: { $ne: null, $lte: cutoff }
  }).limit(500);

  for (const candidate of awaiting) {
    const journey = await SafetyJourney.findOneAndUpdate(
      { _id: candidate._id, status: "OVERDUE_UNCONFIRMED", sharingEnabled: true, checkInRequestedAt: { $lte: cutoff } },
      { $set: { status: "ALERT_SENT", alertSentAt: now } },
      { new: true }
    );
    if (!journey) continue;
    await notifyJourneyRecipients({
      io,
      journey,
      recipients: journey.sharedWith,
      type: "journey_overdue_alert",
      title: "Journey arrival not confirmed",
      body: journey.travellerUsername + " has not confirmed arrival after the expected time. This is an overdue safety check, not confirmation of an emergency.",
      payload: { journeyId: String(journey._id), status: journey.status, expectedArrivalAt: journey.expectedArrivalAt },
      keySuffix: "overdue-alert"
    });
    for (const recipientId of journey.sharedWith || []) {
      io?.to("user:" + recipientId).emit("journey-update", {
        journeyId: String(journey._id),
        travellerId: String(journey.travellerId),
        travellerUsername: journey.travellerUsername,
        status: journey.status,
        expectedArrivalAt: journey.expectedArrivalAt,
        alertSentAt: journey.alertSentAt
      });
    }
  }
}

function startSafetyJourneyWorker(io) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processSafetyDeadlines(io);
    } catch (error) {
      console.error("[SafetyJourneyWorker] Deadline processing failed:", error.message);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  console.log("[SafetyJourneyWorker] Started; polling every " + POLL_INTERVAL_MS + " ms.");
  return () => clearInterval(timer);
}

module.exports = { processSafetyDeadlines, startSafetyJourneyWorker };
