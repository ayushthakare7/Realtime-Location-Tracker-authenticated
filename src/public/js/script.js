const token = localStorage.getItem("token");
if (!token) window.location.replace("/login");

const api = async (path, options = {}) => {
  const response = await fetch("/api/tracker" + path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
};

const map = L.map("map").setView([20.5937, 78.9629], 5);
const baseTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(map);

// Keep camera movement at a consistent visual pace even when locations are far apart.
function flyToAtSteadyPace(target, zoom) {
  const targetPoint = L.latLng(target);
  const startPoint = map.getCenter();
  const startPixel = map.project(startPoint, zoom);
  const targetPixel = map.project(targetPoint, zoom);
  const pixelDistance = startPixel.distanceTo(targetPixel);
  const zoomDistance = Math.abs(map.getZoom() - zoom);
  // Scale travel time with projected distance so distant friends do not get a rushed flyover.
  const seconds = Math.max(1.9, Math.min(3.8, pixelDistance / 430 + zoomDistance * 0.16));
  map.flyTo(targetPoint, zoom, {
    duration: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : seconds,
    easeLinearity: 0.22
  });
}

// Give visible map tiles time to finish loading after each camera move.
function waitForMapTiles(maxWait = 4200) {
  return new Promise(resolve => {
    let settled = false;
    let settleTimer;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      clearTimeout(settleTimer);
      baseTiles.off("load", onTilesLoaded);
      map.off("moveend", onMoveEnd);
      resolve();
    };
    const finishAfterBreathingRoom = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(cleanup, 650);
    };
    const onTilesLoaded = () => finishAfterBreathingRoom();
    const onMoveEnd = () => {
      if (!baseTiles.isLoading()) finishAfterBreathingRoom();
    };
    const maxTimer = setTimeout(cleanup, maxWait);
    baseTiles.on("load", onTilesLoaded);
    map.on("moveend", onMoveEnd);
    if (!baseTiles.isLoading()) finishAfterBreathingRoom();
  });
}

const markers = new Map();
const accuracyCircles = new Map();
const profileByUser = new Map();
const avatarEmoji = { "child-boy":"🧒", "child-girl":"👧", "college-boy":"🧑‍🎓", "college-girl":"👩‍🎓", "adult-man":"👨", "adult-woman":"👩" };
let sharing = false;
let historyEnabled = true;
let watchId = null;
let socket;
let lastSent = null;
let lastSentAt = 0;
let latestPosition = null;
let radarAnimationRunning = false;
let radarAnimationDone = false;
let radarFocusedOnMe = false;

function setStatus(message) { document.getElementById("status").textContent = message; }
function ageText(date) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  return minutes < 1 ? "just now" : minutes === 1 ? "1 min ago" : `${minutes} min ago`;
}
function distanceMeters(aLat, aLon, bLat, bLon) {
  const rad = v => v * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function createRadarIcon(isMe, data = {}) {
  const key = String(data.userId || data.username || (isMe ? "me" : ""));
  const profile = { ...(profileByUser.get(key) || {}), ...data };
  const image = typeof profile.profileImage === "string" && /^data:image\\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(profile.profileImage) ? profile.profileImage : "";
  const emoji = avatarEmoji[profile.avatarId] || (isMe ? "🧑‍🎓" : "🧑");
  const root = document.createElement("span");
  root.className = "reva-avatar-marker";
  root.style.cssText = "display:flex;width:42px;height:42px;box-sizing:border-box;align-items:center;justify-content:center;overflow:hidden;border-radius:50%;background:#e8efe7;border:3px solid #fff;box-shadow:0 3px 12px rgba(33,52,42,.3);font-size:25px;line-height:1;";
  if (image) {
    const photo = document.createElement("img");
    photo.alt = (profile.username || data.username || (isMe ? "Your" : "Friend")) + " profile photo";
    photo.src = image;
    photo.style.cssText = "display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:cover;border-radius:50%;";
    photo.onerror = () => {
      photo.remove();
      root.textContent = emoji;
      root.setAttribute("aria-label", "Avatar photo unavailable");
    };
    root.append(photo);
  } else {
    root.textContent = emoji;
    root.setAttribute("aria-label", (profile.username || data.username || (isMe ? "Your" : "Friend")) + " avatar");
  }
  return L.divIcon({ className: "reva-marker-shell", html: root, iconSize: [42, 42], iconAnchor: [21, 21] });
}

function upsertMarker(data, accuracy) {
  if (!data || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) return;
  const id = String(data.userId || data.username);
  if (data.avatarId || data.profileImage !== undefined) profileByUser.set(id, { ...(profileByUser.get(id) || {}), avatarId: data.avatarId, profileImage: data.profileImage || "" });
  const point = [Number(data.latitude), Number(data.longitude)];
  if (markers.has(id)) {
    const marker = markers.get(id); marker.setLatLng(point);
    if (data.avatarId || data.profileImage !== undefined) marker.setIcon(createRadarIcon(id === "me", { ...profileByUser.get(id), userId: id }));
  } else {
    const marker = L.marker(point, { icon: createRadarIcon(id === "me", { ...profileByUser.get(id), ...data }) }).addTo(map).bindTooltip(data.username || "Friend", { permanent: true, direction: "top" });
    markers.set(id, marker);
  }
  if (accuracy && Number.isFinite(Number(accuracy))) {
    if (accuracyCircles.has(id)) accuracyCircles.get(id).setLatLng(point).setRadius(Number(accuracy));
    else accuracyCircles.set(id, L.circle(point, { radius: Number(accuracy), weight: 1, fillOpacity: 0.08 }).addTo(map));
  }
}
async function animateCrewReveal() {
  const hint = document.getElementById("mapHint");
  if (!hint || radarAnimationRunning || radarAnimationDone) return;
  const ownMarker = markers.get("me");
  if (!ownMarker || !sharing) {
    hint.textContent = "Turn on sharing to bring your place onto the radar";
    return;
  }

  radarAnimationRunning = true;
  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = ms => new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : ms));
  const duration = seconds => reducedMotion ? 0 : seconds;
  try {
    // Reveal friends first, then finish by focusing on the user's own location.
    // This avoids the old own → friends → own camera sequence.
    const crew = [...markers.entries()].filter(([id, marker]) =>
      id !== "me" && marker && marker.getLatLng()
    );

    if (crew.length) {
      for (const [id, marker] of crew) {
        const tooltip = marker.getTooltip();
        const friendName = tooltip ? String(tooltip.getContent()) : "your friend";
        hint.textContent = "Connecting the dots · " + friendName;
        const markerElement = marker.getElement();
        if (markerElement) markerElement.classList.add("radar-targeted");
        flyToAtSteadyPace(marker.getLatLng(), 13);
        await waitForMapTiles();
        // Keep every friend's pin and label visible for the same amount of time.
        await wait(reducedMotion ? 0 : 650);
        if (markerElement) markerElement.classList.remove("radar-targeted");
      }
    }

    // Finish on the user's own position at a useful close city/neighbourhood zoom.
    // Never fit all friends into the viewport or zoom out to the whole country.
    hint.textContent = "Returning to your location…";
    flyToAtSteadyPace(ownMarker.getLatLng(), 15);
    await waitForMapTiles();

    hint.textContent = crew.length
      ? crew.length + " friend" + (crew.length === 1 ? "" : "s") + " on your radar · shared locations only"
      : "You're on the radar. Add friends to bring your crew into orbit.";
    radarAnimationDone = true;
  } finally {
    radarAnimationRunning = false;
  }
}

function removeMarker(id) {
  const key = String(id);
  const marker = markers.get(key); if (marker) map.removeLayer(marker);
  const circle = accuracyCircles.get(key); if (circle) map.removeLayer(circle);
  markers.delete(key); accuracyCircles.delete(key);
}
function sendLatestPosition(force = false) {
  if (!sharing || !latestPosition || !socket || !socket.connected) return false;
  const { latitude, longitude, accuracy } = latestPosition;
  const moved = !lastSent || distanceMeters(lastSent.lat, lastSent.lon, latitude, longitude) >= 30;
  const enoughTime = Date.now() - lastSentAt >= 15000;
  if (!force && !moved && !enoughTime) return false;
  socket.emit("send-location", { latitude, longitude, accuracyMeters: accuracy });
  lastSent = { lat: latitude, lon: longitude };
  lastSentAt = Date.now();
  upsertMarker({ userId: "me", username: "You", latitude, longitude }, accuracy);
  document.getElementById("gpsInfo").textContent = `GPS accuracy ±${Math.round(accuracy || 0)} m • ${new Date().toLocaleTimeString()}`;
  return true;
}
function handlePosition(position) {
  latestPosition = {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy
  };
  upsertMarker({ userId: "me", username: "You", latitude: latestPosition.latitude, longitude: latestPosition.longitude }, latestPosition.accuracy);
  animateCrewReveal();
  if (sendLatestPosition(false)) setStatus("Location updated. Your current position is being shared with accepted friends.");
  else if (!socket || !socket.connected) setStatus("GPS location received. Waiting for the secure connection to send it…");
}
function handleLocationError(error) {
  const messages = {
    1: "Location permission was denied. Allow location access in your browser and try again.",
    2: "Your device could not determine a location. Check GPS/location services and try again.",
    3: "Getting your location timed out. Keep location services enabled and try again."
  };
  setStatus(messages[error.code] || "Unable to read your current location.");
}

function markMobilityNotificationRead(id) {
  if (!id) return Promise.resolve();
  return fetch("/api/mobility-notifications/" + encodeURIComponent(id) + "/read", {
    method: "PATCH", headers: { Authorization: "Bearer " + token }
  }).catch(() => {});
}
function showMobilityNotice(data) {
  if (!data || !data.tripId) return;
  document.getElementById("mobilityNotice")?.remove();
  const titles = { journey_started: "Journey started", journey_delayed: "Journey delayed", journey_arrived: "Arrival confirmed", journey_ended: "Journey ended" };
  const card = document.createElement("div");
  card.id = "mobilityNotice";
  card.style.cssText = "position:fixed;z-index:3000;right:16px;bottom:16px;width:min(360px,calc(100vw - 32px));padding:16px;border:1px solid #dce6dc;border-radius:16px;background:#fffdf8;box-shadow:0 18px 50px #20382c30;color:#24332f";
  const title = document.createElement("strong");
  title.textContent = data.title || titles[data.type] || "Journey update";
  title.style.cssText = "display:block;font:700 14px Manrope,sans-serif";
  const detail = document.createElement("p");
  detail.textContent = data.body || ((data.travellerUsername || "Your friend") + (data.destination?.label ? " · " + data.destination.label : "") + (data.expectedArrivalAt ? " · ETA " + new Date(data.expectedArrivalAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : ""));
  detail.style.cssText = "margin:7px 0 12px;color:#78847d;font-size:12px";
  const open = document.createElement("a");
  open.href = data.viewPath || data.payload?.viewPath || ("/mobility/shared/" + encodeURIComponent(data.tripId));
  open.textContent = "View shared journey →";
  open.style.cssText = "display:inline-block;padding:8px 11px;border-radius:10px;background:#294d40;color:white;text-decoration:none;font-size:12px;font-weight:700";
  open.addEventListener("click", async event => { event.preventDefault(); await markMobilityNotificationRead(data.notificationId || data.id); window.location.href = open.href; });
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "Dismiss";
  close.style.cssText = "float:right;border:0;background:transparent;color:#78847d;padding:8px;font-size:12px";
  close.addEventListener("click", () => { void markMobilityNotificationRead(data.notificationId || data.id); card.remove(); });
  card.append(title, detail, open, close); document.body.append(card);
  setTimeout(() => card.remove(), 20000);
}
async function loadSharedJourneys() {
  const root = document.getElementById("sharedJourneys");
  if (!root) return;
  try {
    const response = await fetch("/api/mobility/trips/shared", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Could not load shared journeys.");
    root.replaceChildren();
    const trips = Array.isArray(data.trips) ? data.trips : [];
    if (!trips.length) {
      const empty = document.createElement("p");
      empty.className = "muted shared-journeys-empty";
      empty.textContent = "No active journeys have been shared with you yet.";
      root.append(empty);
      return;
    }
    trips.forEach(trip => {
      const card = document.createElement("article");
      card.className = "shared-journey-item";
      const finished = ["ARRIVED", "COMPLETED"].includes(trip.status);
      if (finished) card.classList.add("shared-journey-finished");
      const top = document.createElement("div");
      top.className = "shared-journey-top";
      const traveller = document.createElement("strong");
      traveller.textContent = trip.travellerUsername || "Your friend";
      const status = document.createElement("span");
      status.className = "shared-journey-status";
      status.textContent = trip.status === "ARRIVED" ? "Arrived" : trip.status === "COMPLETED" ? "Journey ended" : trip.status === "DELAYED" ? "Delayed" : "Live";
      top.append(traveller, status);
      const destination = document.createElement("p");
      destination.className = "muted";
      if (trip.status === "ARRIVED") {
        const when = trip.arrivedAt ? " at " + new Date(trip.arrivedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "";
        destination.textContent = (trip.travellerUsername || "Your friend") + " has arrived at " + (trip.destination?.label || "their destination") + when + ".";
      } else if (trip.status === "COMPLETED") {
        destination.textContent = (trip.travellerUsername || "Your friend") + "'s journey has ended.";
      } else {
        destination.textContent = (trip.destination?.label || "Destination not labelled") + (trip.expectedArrivalAt ? " · ETA " + new Date(trip.expectedArrivalAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "");
      }
      card.append(top, destination);
      if (finished) {
        const acknowledge = document.createElement("button");
        acknowledge.type = "button";
        acknowledge.className = "shared-journey-dismiss";
        acknowledge.textContent = "OK · Remove";
        acknowledge.addEventListener("click", async () => {
          acknowledge.disabled = true;
          acknowledge.textContent = "Removing…";
          try {
            const response = await fetch("/api/mobility/trips/shared/" + encodeURIComponent(trip.id) + "/dismiss", {
              method: "POST",
              headers: { Authorization: "Bearer " + token }
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.message || "Could not remove this journey.");
            card.remove();
            if (!root.querySelector(".shared-journey-item")) {
              const empty = document.createElement("p");
              empty.className = "muted shared-journeys-empty";
              empty.textContent = "No active journeys have been shared with you yet.";
              root.append(empty);
            }
          } catch (error) {
            acknowledge.disabled = false;
            acknowledge.textContent = "OK · Remove";
            acknowledge.title = error.message;
          }
        });
        card.append(acknowledge);
      } else {
        const link = document.createElement("a");
        link.className = "shared-journey-open";
        link.href = "/mobility/shared/" + encodeURIComponent(trip.id);
        link.textContent = "View live journey →";
        card.append(link);
      }
      root.append(card);
    });
  } catch (error) {
    root.replaceChildren();
    const note = document.createElement("p");
    note.className = "muted shared-journeys-empty";
    note.textContent = "Shared journeys are temporarily unavailable. " + error.message;
    root.append(note);
  }
}

async function loadMobilityNotifications() {
  try {
    const response = await fetch("/api/mobility-notifications", { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) return;
    const data = await response.json();
    if (data.notifications?.length) showMobilityNotice(data.notifications[0]);
  } catch (_) {}
}

async function loadOwnProfileMarker() {
  try {
    const response = await fetch("/api/profile", { headers: { Authorization: "Bearer " + token } });
    const data = await response.json();
    if (!response.ok || !data.profile) return;
    const profile = { avatarId: data.profile.avatarId || "college-boy", profileImage: data.profile.profileImage || "" };
    profileByUser.set("me", profile);
    const marker = markers.get("me");
    if (marker) marker.setIcon(createRadarIcon(true, { userId: "me", username: "You", ...profile }));
    for (const [id, existingMarker] of markers) {
      if (id !== "me" && profileByUser.has(id)) existingMarker.setIcon(createRadarIcon(false, { userId: id, ...profileByUser.get(id) }));
    }
  } catch (error) {
    console.warn("Could not load own map avatar:", error.message);
  }
}

function connectSocket() {
  socket = io({ auth: { token } });
  socket.on("connect", () => {
    setStatus("Connected. Location sharing is " + (sharing ? "on." : "off."));
    if (sharing && latestPosition) sendLatestPosition(true);
  });
  socket.on("connect_error", error => setStatus("Socket connection: " + error.message));
  socket.on("sharing-status", data => { if (data) historyEnabled = data.historyEnabled !== false; if (!sharing) setStatus(data.enabled ? "Your sharing is enabled on this account." : "Sharing is off until you opt in."); });
  socket.on("receive-location", data => {
    if (!data) return;
    const id = String(data.userId || data.username || "");
    // Preserve cached avatar details when a live GPS update arrives without profile fields.
    const profile = profileByUser.get(id);
    upsertMarker(profile ? { ...data, ...profile } : data);
  });
  socket.on("sharing-stopped", data => { if (data && data.userId) removeMarker(data.userId); });
  socket.on("friend-removed", data => { if (data && data.userId) { removeMarker(data.userId); loadFriends({ quiet: true }); } });
  socket.on("friend-request-received", data => { if (data && data.username) setStatus("New friend request from " + data.username + "."); loadFriends(); });
  socket.on("mobility-notification", data => { showMobilityNotice(data); loadSharedJourneys(); });
}
connectSocket();
loadMobilityNotifications();
loadSharedJourneys();
setInterval(loadSharedJourneys, 30000);

async function loadFriends({ quiet = false } = {}) {
  try {
    const data = await api("/friends");
    const friendRoot = document.getElementById("friends");
    friendRoot.replaceChildren();
    if (!data.friends.length) friendRoot.textContent = "No accepted friends yet.";
    data.friends.forEach(friend => {
      const item = document.createElement("div"); item.className = "friend";
      const title = document.createElement("strong"); title.textContent = friend.username;
      const detail = document.createElement("div"); detail.className = "muted";
      detail.textContent = friend.sharingEnabled ? `${friend.location?.placeName || "Location available"} • ${friend.location ? ageText(friend.location.lastSeen) : "waiting for GPS"}` : "Not sharing";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary friend-remove";
      remove.textContent = "Remove friend";
      remove.setAttribute("aria-label", "Remove " + friend.username + " from friends");
      remove.onclick = async () => {
        if (!window.confirm(`Remove ${friend.username} from your friends? They will no longer appear in your friends list or share locations with you through this friendship.`)) return;
        remove.disabled = true;
        try {
          await api("/friends/" + encodeURIComponent(friend.id), { method: "DELETE" });
          removeMarker(friend.id);
          await loadFriends({ quiet: true });
          setStatus(friend.username + " was removed from your friends.");
        } catch (error) {
          remove.disabled = false;
          alert(error.message || "Could not remove friend.");
        }
      };
      item.append(title, detail, remove); friendRoot.append(item);
      profileByUser.set(String(friend.id), { avatarId: friend.avatarId || "college-boy", profileImage: friend.profileImage || "", username: friend.username });
      if (friend.location) upsertMarker({ ...friend.location, userId: friend.id, username: friend.username, avatarId: friend.avatarId || "college-boy", profileImage: friend.profileImage || "" }); else removeMarker(friend.id);
      const friendMarker = markers.get(String(friend.id));
      if (friendMarker) friendMarker.setIcon(createRadarIcon(false, { userId: String(friend.id), username: friend.username, avatarId: friend.avatarId || "college-boy", profileImage: friend.profileImage || "" }));
    });
    const requestRoot = document.getElementById("requests"); requestRoot.replaceChildren();
    if (data.requests.length) {
      const heading = document.createElement("h4"); heading.textContent = "Incoming requests"; requestRoot.append(heading);
      data.requests.forEach(request => {
        const row = document.createElement("div"); row.className = "friend";
        const label = document.createElement("span"); label.textContent = request.username + " ";
        const accept = document.createElement("button"); accept.textContent = "Accept";
        accept.onclick = async () => { try { await api("/friends/requests/" + request.id + "/respond", { method: "POST", body: JSON.stringify({ status: "accepted" }) }); await loadFriends(); } catch (e) { alert(e.message); } };
        const decline = document.createElement("button"); decline.textContent = "Decline"; decline.className = "secondary";
        decline.onclick = async () => { try { await api("/friends/requests/" + request.id + "/respond", { method: "POST", body: JSON.stringify({ status: "declined" }) }); await loadFriends(); } catch (e) { alert(e.message); } };
        row.append(label, accept, decline); requestRoot.append(row);
      });
    }
    sharing = Boolean(data.sharingEnabled); historyEnabled = data.historyEnabled !== false;
    document.getElementById("historyToggle").checked = historyEnabled;
    if (!quiet) setStatus(sharing ? "Sharing is enabled. Accepted friends can see your latest location." : "Sharing is off. Your location is not being broadcast.");
    if (sharing && latestPosition && socket?.connected) sendLatestPosition(true);
    if (sharing && latestPosition) animateCrewReveal();
  } catch (e) { if (!quiet) setStatus(e.message); }
}

async function setSharing(enabled) {
  try {
    if (enabled) {
      radarAnimationDone = false;
      radarFocusedOnMe = false;
    }
    const data = await api("/sharing", { method: "PATCH", body: JSON.stringify({ enabled }) });
    sharing = data.sharingEnabled;
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null; lastSent = null; lastSentAt = 0;
    if (sharing) {
      if (!navigator.geolocation) throw new Error("This browser does not support geolocation.");
      setStatus("Sharing enabled. Getting your current GPS location…");
      navigator.geolocation.getCurrentPosition(handlePosition, handleLocationError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
      watchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
    } else {
      latestPosition = null;
      setStatus("Sharing stopped. Your latest location was removed; history follows your history setting.");
      removeMarker("me");
    }
    await loadFriends();
    // If the user was sent here from Plan a Journey, return once sharing is enabled.
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    if (sharing && returnTo === "/mobility") {
      setStatus("Location sharing enabled. Returning to Plan a Journey…");
      window.location.replace("/mobility?resumeJourney=1");
    }
  } catch (e) { setStatus(e.message); }
}

async function setHistory(enabled) {
  try {
    const data = await api("/history", { method: "PATCH", body: JSON.stringify({ enabled }) });
    historyEnabled = data.historyEnabled;
    setStatus(historyEnabled ? "Location history enabled." : "Location history disabled. New tracking points and semantic events will not be stored.");
  } catch (e) { document.getElementById("historyToggle").checked = !enabled; alert(e.message); }
}

async function deleteHistory() {
  if (!confirm("Delete your stored location history, visits and semantic events? This cannot be undone.")) return;
  try { await api("/history", { method: "DELETE" }); setStatus("Your location history was deleted."); } catch (e) { alert(e.message); }
}

document.getElementById("start").addEventListener("click", () => setSharing(true));
document.getElementById("stop").addEventListener("click", () => setSharing(false));
document.getElementById("historyToggle").addEventListener("change", event => setHistory(event.target.checked));
document.getElementById("deleteHistory").addEventListener("click", deleteHistory);
document.getElementById("logout").addEventListener("click", () => { if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); localStorage.removeItem("token"); if (socket) socket.disconnect(); window.location.replace("/login"); });
document.getElementById("friendForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/friends/request", { method: "POST", body: JSON.stringify({ username: document.getElementById("friendUsername").value.trim() }) }); document.getElementById("friendUsername").value = ""; alert("Friend request sent."); await loadFriends(); } catch (e) { alert(e.message); } });
document.getElementById("askForm").addEventListener("submit", async event => { event.preventDefault(); const answer = document.getElementById("answer"); answer.textContent = "Reva is connecting the dots in your shared location story…"; try { const data = await api("/ask", { method: "POST", body: JSON.stringify({ question: document.getElementById("question").value, aiConsent: document.getElementById("aiConsent").checked }) }); answer.textContent = data.answer; } catch (e) { answer.textContent = e.message; } });

document.querySelectorAll("[data-question]").forEach(button => button.addEventListener("click", () => {
  const question = button.dataset.question;
  if (!question) return;
  document.getElementById("question").value = question;
  document.getElementById("question").focus();
}));

document.getElementById("currentLocationPrompt").addEventListener("click", () => {
  document.getElementById("question").value = "Where am I currently?";
  document.getElementById("question").focus();
});

loadFriends();
loadOwnProfileMarker();

/* Free, client-side profile photo compression and avatar editor. */
(() => {
  const modal=document.getElementById("profileModal");
  if(!modal) return;
  let avatarId="college-boy", profileImage="", pendingImage=null;
  const preview=document.getElementById("profilePreview"), options=document.getElementById("profileAvatarOptions"), message=document.getElementById("profileMessage");
  const render=()=>{ preview.src=profileImage||"data:image/svg+xml;charset=utf-8,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#e9efe7"/><text x="40" y="56" font-size="44" text-anchor="middle">'+(avatarEmoji[avatarId]||"🧑‍🎓")+'</text></svg>'); options.replaceChildren(); Object.entries(avatarEmoji).forEach(([id,emoji])=>{const b=document.createElement("button");b.type="button";b.className="profile-avatar-choice"+(!profileImage&&id===avatarId?" selected":"");const face=document.createElement("span");face.textContent=emoji;const label=document.createElement("small");label.textContent=({"child-boy":"Child boy","child-girl":"Child girl","college-boy":"College boy","college-girl":"College girl","adult-man":"Adult man","adult-woman":"Adult woman"})[id];b.append(face,label);b.onclick=()=>{avatarId=id;profileImage="";pendingImage="";document.getElementById("profilePhotoEdit").value="";render();message.textContent="Preset avatar selected. Save marker to apply it.";};options.append(b);});};
  const compress=async file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=reject;reader.onload=()=>{const img=new Image();img.onerror=reject;img.onload=()=>{const c=document.createElement("canvas"),s=Math.min(1,320/Math.max(img.width,img.height));c.width=Math.max(1,Math.round(img.width*s));c.height=Math.max(1,Math.round(img.height*s));c.getContext("2d").drawImage(img,0,0,c.width,c.height);let q=.78,d=c.toDataURL("image/jpeg",q);while(d.length>112000&&q>.35){q-=.1;d=c.toDataURL("image/jpeg",q);}d.length<=112000?resolve(d):reject(new Error("Photo is too large after compression. Choose another."));};img.src=reader.result;};reader.readAsDataURL(file);});
  document.getElementById("profileOpen").addEventListener("click",async()=>{modal.hidden=false;message.textContent="Loading profile…";try{const r=await fetch("/api/profile",{headers:{Authorization:"Bearer "+token}}),d=await r.json();if(!r.ok)throw new Error(d.message);avatarId=d.profile.avatarId||"college-boy";profileImage=d.profile.profileImage||"";pendingImage=null;document.getElementById("profilePhotoEdit").value="";render();message.textContent=profileImage?"Your personal photo is saved. It will replace the preset avatar on the map.":"";}catch(e){message.textContent=e.message||"Could not load profile.";}});
  document.getElementById("profileClose").onclick=()=>{modal.hidden=true;};
  modal.addEventListener("click",e=>{if(e.target===modal)modal.hidden=true;});
  document.getElementById("profilePhotoEdit").addEventListener("change",async e=>{const f=e.target.files?.[0];if(!f)return;try{if(!f.type.startsWith("image/"))throw new Error("Choose an image file.");pendingImage=await compress(f);profileImage=pendingImage;render();message.textContent="Personal photo selected. Save marker to replace the preset with your photo.";}catch(err){message.textContent=err.message||"Could not process photo.";e.target.value="";}});
  document.getElementById("profileSave").addEventListener("click",async()=>{const b=document.getElementById("profileSave");b.disabled=true;b.textContent="Saving…";try{const payload={avatarId};if(pendingImage!==null)payload.profileImage=pendingImage;const r=await fetch("/api/profile",{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(payload)}),d=await r.json();if(!r.ok)throw new Error(d.message);avatarId=d.profile.avatarId||avatarId;profileImage=d.profile.profileImage||"";pendingImage=null;profileByUser.set("me",{avatarId,profileImage,username:"You"});const ownMarker=markers.get("me");if(ownMarker)ownMarker.setIcon(createRadarIcon(true,{userId:"me",username:"You",avatarId,profileImage}));if(latestPosition)upsertMarker({userId:"me",username:"You",latitude:latestPosition.latitude,longitude:latestPosition.longitude,avatarId,profileImage});message.textContent=profileImage?"Your personal photo is saved in MongoDB and applied to your map marker.":"Your avatar is saved in MongoDB and applied to your map marker.";await loadOwnProfileMarker();setTimeout(()=>{modal.hidden=true;},650);}catch(e){message.textContent=e.message||"Could not save your marker.";}finally{b.disabled=false;b.textContent="Save marker";}});
})();
