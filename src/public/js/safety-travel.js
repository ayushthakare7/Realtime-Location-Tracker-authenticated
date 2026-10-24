const token = localStorage.getItem("token");
if (!token) window.location.replace("/login");

const form = document.getElementById("journeyForm");
const feedback = document.getElementById("journeyFeedback");
const connectionStatus = document.getElementById("connectionStatus");
const queueStatus = document.getElementById("queueStatus");
const gpsStatus = document.getElementById("gpsStatus");

let offlineQueue = null;
let queueReady = false;
let trackingJourneyId = null;
let gpsWatchId = null;



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
  if (!navigator.onLine) {
    renderCached();
    return;
  }
  try {
    const response = await fetch("/api/journeys", {
      headers: { "Authorization": "Bearer " + localStorage.getItem("token") }
    });
    if (!response.ok) throw new Error("Could not load journey list.");
    const body = await response.json();
    const activeStatuses = new Set(["ACTIVE", "OVERDUE_UNCONFIRMED", "ALERT_SENT", "EMERGENCY_ALERTED", "ARRIVED"]);
    const candidates = (Array.isArray(body.journeys) ? body.journeys : [])
      .filter(item => activeStatuses.has(item.status) && item.lastConfirmedLocation && Number.isFinite(Date.parse(item.lastConfirmedLocation.recordedAt)))
      .sort((a, b) => Date.parse(b.lastConfirmedLocation.recordedAt) - Date.parse(a.lastConfirmedLocation.recordedAt));
    if (!candidates.length) {
      target.textContent = "No active or recently arrived journey has a server-confirmed location yet.";
      return;
    }
    const latest = candidates[0];
    const summary = {
      traveller: String(latest.travellerUsername || "traveller").slice(0, 80),
      recordedAt: latest.lastConfirmedLocation.recordedAt
    };
    try { localStorage.setItem(cacheKey, JSON.stringify(summary)); } catch (_) {}
    target.textContent = "Last server-confirmed location for " + summary.traveller + ": " + new Date(summary.recordedAt).toLocaleString() + ". This is not necessarily a live position.";
  } catch (_) {
    if (!renderCached()) target.textContent = "Could not load the last server-confirmed location while offline.";
  }
}

function updateLastGpsStatus() {
  const lastGpsStatus = document.getElementById("lastGpsStatus");
  if (!lastGpsStatus) return;
  let value = null;
  try { value = localStorage.getItem("reva-safety-travel-last-gps-at"); } catch (_) {}
  if (!value || !Number.isFinite(Date.parse(value))) {
    lastGpsStatus.textContent = "No GPS fix has been saved on this device yet.";
    return;
  }
  lastGpsStatus.textContent = "Last GPS fix saved on this device: " + new Date(value).toLocaleString() + ". This is not proof that friends have received the location.";
}

function setConnectionStatus() {
  if (!connectionStatus) return;
  if (navigator.onLine) {
    connectionStatus.textContent = "Internet connection available. Checking for saved updates…";
    connectionStatus.dataset.state = "online";
  } else {
    connectionStatus.textContent = "Offline — new journey updates will stay on this device until you reconnect.";
    connectionStatus.dataset.state = "offline";
  }
}

async function refreshQueueStatus() {
  if (!queueStatus) return;
  if (!offlineQueue) {
    queueStatus.textContent = "Local offline queue is unavailable in this browser.";
    return;
  }
  try {
    const state = await offlineQueue.status();
    if (state.pendingCount > 0) {
      queueStatus.textContent = state.pendingCount + " saved update" + (state.pendingCount === 1 ? "" : "s") + " waiting to sync.";
    } else {
      queueStatus.textContent = "No saved journey updates are waiting to sync.";
    }
    if (state.lastError) queueStatus.textContent += " " + state.lastError;
  } catch (_) {
    queueStatus.textContent = "Could not read saved journey updates on this device.";
  }
}

async function refreshGpsPermission() {
  if (!gpsStatus) return;
  if (!navigator.geolocation) {
    gpsStatus.textContent = "GPS location is not supported by this browser.";
    return;
  }
  if (!navigator.permissions || !navigator.permissions.query) {
    gpsStatus.textContent = "GPS permission status is unknown. Reva will ask only when you start a journey.";
    return;
  }
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    const render = () => {
      if (permission.state === "granted") gpsStatus.textContent = "GPS permission is granted. Location is not being recorded until you start an approved journey.";
      else if (permission.state === "denied") gpsStatus.textContent = "GPS permission is blocked. Enable location permission in browser settings before tracking.";
      else gpsStatus.textContent = "GPS permission has not been requested. Reva will ask only when you start a journey.";
    };
    render();
    permission.onchange = render;
  } catch (_) {
    gpsStatus.textContent = "GPS permission status is unknown. Reva will ask only when you start a journey.";
  }
}

if (window.RevaJourneyOfflineQueue) {
  try {
    offlineQueue = window.RevaJourneyOfflineQueue.createJourneyOfflineQueue({
      store: window.RevaJourneyOfflineQueue.createBrowserStore(),
      getToken: () => localStorage.getItem("token"),
      isOnline: () => navigator.onLine
    });
    queueReady = true;
  } catch (_) {
    queueStatus.textContent = "Could not initialize local offline storage.";
  }
}

window.RevaSafetyTravelOffline = Object.freeze({
  async recordEvent(journeyId, event) {
    if (!offlineQueue) throw new Error("Local offline storage is unavailable.");
    if (!trackingJourneyId || trackingJourneyId !== String(journeyId)) throw new Error("Start an explicitly approved and consented journey before recording events.");
    const eventId = await offlineQueue.enqueue(journeyId, event);
    await refreshQueueStatus();
    return eventId;
  },
  async recordLocation(journeyId, position) {
    if (!position || !position.coords) throw new Error("A valid GPS position is required.");
    const recordedAt = new Date(position.timestamp || Date.now()).toISOString();
    const eventId = await this.recordEvent(journeyId, {
      type: "location",
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy,
      recordedAt
    });
    try { localStorage.setItem("reva-safety-travel-last-gps-at", recordedAt); } catch (_) {}
    updateLastGpsStatus();
    return eventId;
  },
  async recordConnection(journeyId, online) {
    return this.recordEvent(journeyId, { type: online ? "online" : "offline", recordedAt: new Date().toISOString() });
  },
  startTracking(journeyId, approval) {
    if (!navigator.geolocation) throw new Error("GPS is not supported by this browser.");
    if (!approval || approval.approved !== true || approval.consent !== true) throw new Error("Explicit user consent and backend route approval are required before GPS tracking.");
    if (!/^[a-f\d]{24}$/i.test(String(journeyId || ""))) throw new Error("Start tracking only after the backend confirms an approved journey.");
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
    trackingJourneyId = String(journeyId);
    void this.recordConnection(trackingJourneyId, navigator.onLine).catch(() => {});
    gpsWatchId = navigator.geolocation.watchPosition(
      position => { void this.recordLocation(trackingJourneyId, position).catch(error => { if (gpsStatus) gpsStatus.textContent = "GPS was received, but saving the journey update failed: " + error.message; }); },
      error => {
        if (!gpsStatus) return;
        gpsStatus.textContent = error.code === 1 ? "GPS permission denied. Enable location permission to track this journey." : error.code === 2 ? "GPS signal unavailable. The last saved location is retained." : "GPS timed out. Reva will keep the last saved location until another fix is available.";
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    if (gpsStatus) gpsStatus.textContent = "Journey tracking is active. GPS updates are saved locally if the internet disconnects.";
    return { journeyId: trackingJourneyId, watchId: gpsWatchId };
  },
  stopTracking() {
    if (gpsWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    trackingJourneyId = null;
    if (gpsStatus) gpsStatus.textContent = "Journey tracking is stopped. GPS is no longer being recorded.";
  },
  async flush() {
    if (!offlineQueue) throw new Error("Local offline storage is unavailable.");
    const result = await offlineQueue.flush();
    setConnectionStatus();
    await refreshQueueStatus();
    return result;
  },
  async status() {
    if (!offlineQueue) return { available: false };
    return { available: true, ...(await offlineQueue.status()) };
  }
});

setConnectionStatus();
updateLastGpsStatus();
refreshServerLocationStatus();
refreshGpsPermission();
if (queueReady) {
  refreshQueueStatus();
  if (navigator.onLine) offlineQueue.flush().then(() => {
    setConnectionStatus();
    refreshQueueStatus();
  });
}
window.addEventListener("online", () => {
  setConnectionStatus();
  refreshServerLocationStatus();
  if (offlineQueue) {
    if (trackingJourneyId) void window.RevaSafetyTravelOffline.recordConnection(trackingJourneyId, true).catch(() => {});
    offlineQueue.flush().then(refreshQueueStatus);
  }
});
window.addEventListener("offline", () => {
  setConnectionStatus();
  if (trackingJourneyId) void window.RevaSafetyTravelOffline.recordConnection(trackingJourneyId, false).catch(() => {});
  refreshQueueStatus();
});

form.addEventListener("submit", event => {
  event.preventDefault();
  feedback.textContent = "Offline status and local queue are ready, but journey creation and route approval are not connected to this form yet. No journey has started and GPS is not being recorded. Start tracking only after a journey is created and you explicitly approve it.";
  feedback.classList.add("visible");
});
