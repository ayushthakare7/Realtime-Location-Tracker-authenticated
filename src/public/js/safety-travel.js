const token = localStorage.getItem("token");
if (!token) window.location.replace("/login");

const form = document.getElementById("journeyForm");
const feedback = document.getElementById("journeyFeedback");
const connectionStatus = document.getElementById("connectionStatus");
const queueStatus = document.getElementById("queueStatus");
const gpsStatus = document.getElementById("gpsStatus");

let offlineQueue = null;
let queueReady = false;

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
    const eventId = await offlineQueue.enqueue(journeyId, event);
    await refreshQueueStatus();
    return eventId;
  },
  async recordLocation(journeyId, position) {
    if (!position || !position.coords) throw new Error("A valid GPS position is required.");
    return this.recordEvent(journeyId, {
      type: "location",
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy,
      recordedAt: new Date(position.timestamp || Date.now()).toISOString()
    });
  },
  async recordConnection(journeyId, online) {
    return this.recordEvent(journeyId, { type: online ? "online" : "offline", recordedAt: new Date().toISOString() });
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
  if (offlineQueue) offlineQueue.flush().then(refreshQueueStatus);
});
window.addEventListener("offline", () => {
  setConnectionStatus();
  refreshQueueStatus();
});

form.addEventListener("submit", event => {
  event.preventDefault();
  feedback.textContent = "Offline status and local queue are ready, but journey creation and route approval are not connected to this form yet. No journey has started and GPS is not being recorded. Start tracking only after a journey is created and you explicitly approve it.";
  feedback.classList.add("visible");
});
