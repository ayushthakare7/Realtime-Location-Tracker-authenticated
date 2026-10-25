const baseUrl = () => String(process.env.MAIN_APP_INTERNAL_URL || "http://127.0.0.1:3000/api/internal/mobility-events").replace(/\/$/, "");
async function emitMobilityEvent(trip, type) {
  if (!process.env.MOBILITY_CALLBACK_SECRET) { console.warn("[MobilityService] MOBILITY_CALLBACK_SECRET is not set; live recipient notifications are disabled."); return; }
  const payload = { type, tripId: String(trip._id), travellerId: String(trip.userId), travellerUsername: trip.username, status: trip.status, destination: trip.destination, expectedArrivalAt: trip.expectedArrivalAt, arrivedAt: trip.arrivedAt || null, lastLocation: trip.lastLocation || null, recipientMode: trip.recipientMode, recipientIds: (trip.recipients || []).map(String), occurredAt: new Date().toISOString() };
  try {
    const response = await fetch(baseUrl(), { method: "POST", headers: { "Content-Type": "application/json", "X-Mobility-Secret": process.env.MOBILITY_CALLBACK_SECRET }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    if (!response.ok) console.warn("[MobilityService] Main app did not accept event:", type, response.status);
  } catch (error) { console.warn("[MobilityService] Could not deliver event:", type, error.message); }
}
module.exports = { emitMobilityEvent };
