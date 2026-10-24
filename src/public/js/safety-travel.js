const token = localStorage.getItem("token");
if (!token) window.location.replace("/login");

const form = document.getElementById("journeyForm");
const feedback = document.getElementById("journeyFeedback");
const connectionStatus = document.getElementById("connectionStatus");
const queueStatus = document.getElementById("queueStatus");
const gpsStatus = document.getElementById("gpsStatus");
const review = document.getElementById("journeyReview");
const activeControls = document.getElementById("activeJourneyControls");
const friendsStatus = document.getElementById("friendsStatus");
const friendChoices = document.getElementById("friendChoices");
const routeDetails = document.getElementById("routeDetails");
const routeSummary = document.getElementById("routeSummary");
let offlineQueue = null;
let queueReady = false;
let trackingJourneyId = null;
let gpsWatchId = null;
let preparedJourney = null;
let activeJourney = null;
let acceptedFriends = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + localStorage.getItem("token"), ...(options.headers || {}) }
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  if (!response.ok || body.success === false) throw new Error(body.message || "The Safety Travel service could not complete this request.");
  return body;
}
function setFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.add("visible");
  feedback.dataset.state = isError ? "error" : "success";
}
function escapeText(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]); }
function fmtDistance(meters) {
  return meters >= 1000 ? (meters / 1000).toFixed(1) + " km" : Math.round(meters) + " m";
}
function fmtDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? Math.floor(minutes / 60) + " hr " + minutes % 60 + " min" : minutes + " min";
}
async function loadFriends() {
  try {
    const body = await api("/api/tracker/friends");
    acceptedFriends = Array.isArray(body.friends) ? body.friends : [];
    friendsStatus.textContent = acceptedFriends.length ? "Sharing is optional. Select only the accepted friends you want to notify." : "No accepted friends yet. You can still track a journey privately.";
    friendChoices.replaceChildren();
    for (const friend of acceptedFriends) {
      const label = document.createElement("label");
      label.className = "travel-consent";
      const input = document.createElement("input");
      input.type = "checkbox"; input.name = "sharedWith"; input.value = friend.id;
      const span = document.createElement("span"); span.textContent = friend.username;
      label.append(input, span); friendChoices.append(label);
    }
  } catch (_) {
    acceptedFriends = [];
    friendsStatus.textContent = "Could not load accepted friends. You can proceed privately, but sharing is unavailable until friends load.";
  }
}
function selectedFriendIds() {
  return [...friendChoices.querySelectorAll('input[name="sharedWith"]:checked')].map(el => el.value);
}
async function refreshServerLocationStatus() {
  const target = document.getElementById("serverLocationStatus");
  if (!target) return;
  const cacheKey = "reva-safety-travel-last-server-location";
  const renderCached = () => {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (cached && cached.recordedAt && Number.isFinite(Date.parse(cached.recordedAt))) {
        target.textContent = "Last server-confirmed location for " + cached.traveller + ": " + new Date(cached.recordedAt).toLocaleString() + ". Saved status may be stale while offline.";
        return true;
      }
    } catch (_) {}
    target.textContent = "No server-confirmed journey location is cached on this device yet.";
    return false;
  };
  if (!navigator.onLine) { renderCached(); return; }
  try {
    const body = await api("/api/journeys");
    const candidates = (Array.isArray(body.journeys) ? body.journeys : [])
      .filter(item => ["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED"].includes(item.status) && item.lastConfirmedLocation && Number.isFinite(Date.parse(item.lastConfirmedLocation.recordedAt)))
      .sort((a, b) => Date.parse(b.lastConfirmedLocation.recordedAt) - Date.parse(a.lastConfirmedLocation.recordedAt));
    if (!candidates.length) { target.textContent = "No active or recently arrived journey has a server-confirmed location yet."; return; }
    const latest = candidates[0];
    const summary = { traveller: String(latest.travellerUsername || "traveller").slice(0, 80), recordedAt: latest.lastConfirmedLocation.recordedAt };
    try { localStorage.setItem(cacheKey, JSON.stringify(summary)); } catch (_) {}
    target.textContent = "Last server-confirmed location for " + summary.traveller + ": " + new Date(summary.recordedAt).toLocaleString() + ". This is not necessarily a live position.";
  } catch (_) { if (!renderCached()) target.textContent = "Could not load the last server-confirmed location while offline."; }
}
function updateLastGpsStatus() {
  const target = document.getElementById("lastGpsStatus");
  if (!target) return;
  let value = null;
  try { value = localStorage.getItem("reva-safety-travel-last-gps-at"); } catch (_) {}
  target.textContent = !value || !Number.isFinite(Date.parse(value)) ? "No GPS fix has been saved on this device yet." : "Last GPS fix saved on this device: " + new Date(value).toLocaleString() + ". This is not proof that friends have received the location.";
}
function setConnectionStatus() {
  if (!connectionStatus) return;
  connectionStatus.textContent = navigator.onLine ? "Internet connection available. Checking for saved updates…" : "Offline — new journey updates will stay on this device until you reconnect.";
  connectionStatus.dataset.state = navigator.onLine ? "online" : "offline";
}
async function refreshQueueStatus() {
  if (!queueStatus) return;
  if (!offlineQueue) { queueStatus.textContent = "Local offline queue is unavailable in this browser."; return; }
  try {
    const state = await offlineQueue.status();
    queueStatus.textContent = state.pendingCount > 0 ? state.pendingCount + " saved update" + (state.pendingCount === 1 ? "" : "s") + " waiting to sync." : "No saved journey updates are waiting to sync.";
    if (state.lastError || state.error) queueStatus.textContent += " " + (state.lastError || state.error);
  } catch (_) { queueStatus.textContent = "Could not read saved journey updates on this device."; }
}
async function refreshGpsPermission() {
  if (!gpsStatus) return;
  if (!navigator.geolocation) { gpsStatus.textContent = "GPS location is not supported by this browser."; return; }
  if (!navigator.permissions || !navigator.permissions.query) { gpsStatus.textContent = "GPS permission status is unknown. Reva will ask only when you start a journey."; return; }
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    const render = () => {
      if (permission.state === "granted") gpsStatus.textContent = "GPS permission is granted. Location is not being recorded until you start an approved journey.";
      else if (permission.state === "denied") gpsStatus.textContent = "GPS permission is blocked. Enable location permission in browser settings before tracking.";
      else gpsStatus.textContent = "GPS permission has not been requested. Reva will ask only when you start an approved journey.";
    };
    render(); permission.onchange = render;
  } catch (_) { gpsStatus.textContent = "GPS permission status is unknown. Reva will ask only when you start a journey."; }
}
if (window.RevaJourneyOfflineQueue) {
  try {
    offlineQueue = window.RevaJourneyOfflineQueue.createJourneyOfflineQueue({
      store: window.RevaJourneyOfflineQueue.createBrowserStore(),
      getToken: () => localStorage.getItem("token"),
      isOnline: () => navigator.onLine
    });
    queueReady = true;
  } catch (_) { if (queueStatus) queueStatus.textContent = "Could not initialize local offline storage."; }
}
window.RevaSafetyTravelOffline = Object.freeze({
  async recordEvent(journeyId, event) {
    if (!offlineQueue) throw new Error("Local offline storage is unavailable.");
    if (!trackingJourneyId || trackingJourneyId !== String(journeyId)) throw new Error("Start an approved and consented journey before recording events.");
    const eventId = await offlineQueue.enqueue(journeyId, event); await refreshQueueStatus(); return eventId;
  },
  async recordLocation(journeyId, position) {
    if (!position || !position.coords) throw new Error("A valid GPS position is required.");
    const recordedAt = new Date(position.timestamp || Date.now()).toISOString();
    const eventId = await this.recordEvent(journeyId, { type: "location", latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters: position.coords.accuracy, recordedAt });
    try { localStorage.setItem("reva-safety-travel-last-gps-at", recordedAt); } catch (_) {}
    updateLastGpsStatus(); return eventId;
  },
  async recordConnection(journeyId, online) { return this.recordEvent(journeyId, { type: online ? "online" : "offline", recordedAt: new Date().toISOString() }); },
  startTracking(journeyId, approval) {
    if (!navigator.geolocation) throw new Error("GPS is not supported by this browser.");
    if (!approval || approval.approved !== true || approval.consent !== true) throw new Error("Explicit user consent and route approval are required before GPS tracking.");
    if (!/^[a-f\d]{24}$/i.test(String(journeyId || ""))) throw new Error("The backend has not confirmed an approved journey.");
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    trackingJourneyId = String(journeyId);
    void this.recordConnection(trackingJourneyId, navigator.onLine).catch(() => {});
    gpsWatchId = navigator.geolocation.watchPosition(
      position => { void this.recordLocation(trackingJourneyId, position).catch(error => { if (gpsStatus) gpsStatus.textContent = "GPS received, but saving the update failed: " + error.message; }); },
      error => { if (gpsStatus) gpsStatus.textContent = error.code === 1 ? "GPS permission denied. Enable location permission to track this journey." : error.code === 2 ? "GPS signal unavailable. The last saved location is retained." : "GPS timed out. Reva will keep the last saved location until another fix is available."; },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    if (gpsStatus) gpsStatus.textContent = "Journey tracking is active. GPS updates are saved locally if the internet disconnects.";
    return { journeyId: trackingJourneyId, watchId: gpsWatchId };
  },
  stopTracking() {
    if (gpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null; trackingJourneyId = null;
    if (gpsStatus) gpsStatus.textContent = "Journey tracking is stopped. GPS is no longer being recorded.";
  },
  async flush() {
    if (!offlineQueue) throw new Error("Local offline storage is unavailable.");
    const result = await offlineQueue.flush(); setConnectionStatus(); await refreshQueueStatus(); return result;
  },
  async status() { if (!offlineQueue) return { available: false }; return { available: true, ...(await offlineQueue.status()) }; }
});
async function createJourney() {
  const originText = document.getElementById("originText").value.trim();
  const destinationText = document.getElementById("destinationText").value.trim();
  const transportModeId = document.getElementById("travelMode").value || "walking";
  if (!originText || !destinationText) throw new Error("Enter both a starting point and destination.");
  if (document.getElementById("safetyLevel").value === "trusted" && acceptedFriends.length === 0) throw new Error("No accepted friends are available. Choose 'Ask me before sharing' or add a friend first.");
  setFeedback("Creating your private journey draft…");
  const body = await api("/api/journeys", { method: "POST", body: JSON.stringify({
    originText, destinationText, transportModeId, sharedWith: selectedFriendIds(),
    note: document.getElementById("journeyRequest").value.trim() || undefined
  }) });
  preparedJourney = body.journey;
  setFeedback("Journey draft created. Calculating a route for you to review…");
  const routeBody = await api("/api/journeys/" + encodeURIComponent(preparedJourney.id) + "/routes", { method: "POST", body: JSON.stringify({}) });
  preparedJourney.route = routeBody.route;
  preparedJourney.expectedArrivalAt = routeBody.expectedArrivalAt;
  const route = routeBody.route;
  routeSummary.textContent = preparedJourney.origin.label + " → " + preparedJourney.destination.label;
  const eta = routeBody.expectedArrivalAt ? new Date(routeBody.expectedArrivalAt).toLocaleString() : "not available";
  routeDetails.textContent = fmtDistance(route.distanceMeters) + " · about " + fmtDuration(route.durationSeconds) + " · estimated arrival " + eta + ". Provider: " + route.provider + ". Review the route details before approving.";
  review.hidden = false;
  document.getElementById("approveJourney").checked = false;
  document.getElementById("approveJourneyButton").disabled = false;
  setFeedback("Route ready. Nothing is being tracked yet. Review and explicitly approve it below.");
  review.scrollIntoView({ behavior: "smooth", block: "start" });
}
async function approveJourney() {
  if (!preparedJourney) throw new Error("Prepare a route first.");
  if (!document.getElementById("approveJourney").checked) throw new Error("Check the approval box after reviewing the route.");
  const body = await api("/api/journeys/" + encodeURIComponent(preparedJourney.id) + "/approve", { method: "POST", body: JSON.stringify({}) });
  activeJourney = body.journey;
  review.hidden = true; activeControls.hidden = false;
  activeJourneyStatus();
  window.RevaSafetyTravelOffline.startTracking(activeJourney.id, { approved: true, consent: true });
  setFeedback("Route approved. Journey tracking has started on this device.");
  activeControls.scrollIntoView({ behavior: "smooth", block: "start" });
}
function activeJourneyStatus() {
  const target = document.getElementById("activeJourneyStatus");
  if (!activeJourney) return;
  target.textContent = "Status: " + activeJourney.status + ". " + (activeJourney.sharingEnabled ? "Sharing is enabled for the friends you selected." : "This journey is private.");
}
async function eventAction(type) {
  if (!activeJourney) throw new Error("There is no active journey.");
  const label = { check_in: "Safety check-in saved.", arrival: "Arrival recorded.", emergency: "Emergency alert recorded.", cancelled: "Journey cancelled." }[type];
  await window.RevaSafetyTravelOffline.recordEvent(activeJourney.id, { type, recordedAt: new Date().toISOString() });
  if (type === "arrival" || type === "cancelled") {
    window.RevaSafetyTravelOffline.stopTracking(); activeControls.hidden = true; activeJourney = null;
    setFeedback(label + " It will sync when a connection is available.");
  } else if (type === "emergency") {
    setFeedback(label + " This sends an alert to selected friends when synced; if you are in immediate danger, contact local emergency services too.");
  } else {
    if (navigator.onLine) await window.RevaSafetyTravelOffline.flush();
    setFeedback(label + " If offline, it will sync after reconnecting.");
  }
  refreshServerLocationStatus(); activeJourneyStatus();
}
document.getElementById("approveJourneyButton").addEventListener("click", async () => {
  const button = document.getElementById("approveJourneyButton");
  button.disabled = true;
  try { await approveJourney(); } catch (error) { button.disabled = false; setFeedback(error.message, true); }
});
document.getElementById("checkInButton").addEventListener("click", () => eventAction("check_in").catch(error => setFeedback(error.message, true)));
document.getElementById("arrivedButton").addEventListener("click", () => eventAction("arrival").catch(error => setFeedback(error.message, true)));
document.getElementById("emergencyButton").addEventListener("click", () => {
  if (window.confirm("Send an explicit emergency alert to the friends selected for this journey?")) eventAction("emergency").catch(error => setFeedback(error.message, true));
});
document.getElementById("cancelJourneyButton").addEventListener("click", () => eventAction("cancelled").catch(error => setFeedback(error.message, true)));
form.addEventListener("submit", async event => {
  event.preventDefault();
  review.hidden = true; activeControls.hidden = true;
  try { await createJourney(); } catch (error) { setFeedback(error.message, true); }
});
setConnectionStatus();
updateLastGpsStatus();
refreshServerLocationStatus();
refreshGpsPermission();
loadFriends();
if (queueReady) {
  refreshQueueStatus();
  if (navigator.onLine) offlineQueue.flush().then(refreshQueueStatus).catch(() => {});
}
window.addEventListener("online", () => {
  setConnectionStatus(); refreshServerLocationStatus();
  if (trackingJourneyId) void window.RevaSafetyTravelOffline.recordConnection(trackingJourneyId, true).catch(() => {});
  if (offlineQueue) offlineQueue.flush().then(refreshQueueStatus).catch(() => {});
});
window.addEventListener("offline", () => {
  setConnectionStatus();
  if (trackingJourneyId) void window.RevaSafetyTravelOffline.recordConnection(trackingJourneyId, false).catch(() => {});
  refreshQueueStatus();
});
