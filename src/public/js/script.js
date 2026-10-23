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
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(map);
const markers = new Map();
const accuracyCircles = new Map();
let sharing = false;
let historyEnabled = true;
let watchId = null;
let socket;
let lastSent = null;
let lastSentAt = 0;
let latestPosition = null;
let playbackTimer = null;

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
function upsertMarker(data, accuracy) {
  if (!data || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) return;
  const id = String(data.userId || data.username);
  const point = [Number(data.latitude), Number(data.longitude)];
  if (markers.has(id)) markers.get(id).setLatLng(point);
  else {
    const marker = L.marker(point).addTo(map).bindTooltip(data.username || "Friend", { permanent: true, direction: "top" });
    markers.set(id, marker);
  }
  if (accuracy && Number.isFinite(Number(accuracy))) {
    if (accuracyCircles.has(id)) accuracyCircles.get(id).setLatLng(point).setRadius(Number(accuracy));
    else accuracyCircles.set(id, L.circle(point, { radius: Number(accuracy), weight: 1, fillOpacity: 0.08 }).addTo(map));
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
  socket.emit("send-location", { latitude, longitude });
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
function connectSocket() {
  socket = io({ auth: { token } });
  socket.on("connect", () => {
    setStatus("Connected. Location sharing is " + (sharing ? "on." : "off.") );
    if (sharing && latestPosition) sendLatestPosition(true);
  });
  socket.on("connect_error", error => setStatus("Socket connection: " + error.message));
  socket.on("sharing-status", data => { if (data) historyEnabled = data.historyEnabled !== false; if (!sharing) setStatus(data.enabled ? "Your sharing is enabled on this account." : "Sharing is off until you opt in."); });
  socket.on("receive-location", data => upsertMarker(data));
  socket.on("sharing-stopped", data => { if (data && data.userId) removeMarker(data.userId); });
  socket.on("friend-request-received", data => { if (data && data.username) setStatus("New friend request from " + data.username + "."); loadFriends(); });
}
connectSocket();

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
      item.append(title, detail); friendRoot.append(item);
      if (friend.location) upsertMarker({ ...friend.location, userId: friend.id, username: friend.username }); else removeMarker(friend.id);
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
  } catch (e) { if (!quiet) setStatus(e.message); }
}

async function setSharing(enabled) {
  try {
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
  } catch (e) { setStatus(e.message); }
}

async function setHistory(enabled) {
  try {
    const data = await api("/history", { method: "PATCH", body: JSON.stringify({ enabled }) });
    historyEnabled = data.historyEnabled;
    if (!historyEnabled) document.getElementById("timeline").textContent = "History is disabled. New location history will not be stored.";
    else await loadTimeline();
    setStatus(historyEnabled ? "Location history enabled." : "Location history disabled. New tracking points and semantic events will not be stored.");
  } catch (e) { document.getElementById("historyToggle").checked = !enabled; alert(e.message); }
}

async function deleteHistory() {
  if (!confirm("Delete your stored location history, visits and semantic events? This cannot be undone.")) return;
  try { await api("/history", { method: "DELETE" }); await loadTimeline(); setStatus("Your location history was deleted."); } catch (e) { alert(e.message); }
}

async function loadTimeline() {
  const root = document.getElementById("timeline");
  try {
    const data = await api("/history");
    if (!data.historyEnabled) { root.textContent = "History is disabled."; return; }
    const events = data.events || [];
    root.replaceChildren();
    if (!events.length) { root.textContent = "No history yet. Keep sharing for a while to build your timeline."; return; }
    const summary = document.getElementById("dailySummary");
    const grouped = new Map();
    events.forEach(e => { const key = new Date(e.startAt).toLocaleDateString(); if (!grouped.has(key)) grouped.set(key, { places: new Set(), minutes: 0 }); const g = grouped.get(key); g.places.add(e.placeName); g.minutes += Number(e.durationMinutes || 0); });
    const today = grouped.get(new Date().toLocaleDateString());
    summary.textContent = today ? `${today.places.size} places • ${Math.round(today.minutes)} tracked minutes` : "No events recorded today";
    events.slice().reverse().forEach(event => {
      const row = document.createElement("div"); row.className = "timeline-item";
      const when = new Date(event.startAt).toLocaleString();
      row.innerHTML = `<strong>${event.eventType.toUpperCase()}</strong> <span>${event.placeName}</span><div class="muted">${when} • ${Math.round(event.durationMinutes || 0)} min</div>`;
      row.onclick = () => { map.setView([event.latitude, event.longitude], 17); L.popup().setLatLng([event.latitude, event.longitude]).setContent(`<b>${event.placeName}</b><br>${event.summary}`).openOn(map); };
      root.append(row);
    });
    window.timelineEvents = events.filter(e => Number.isFinite(e.latitude) && Number.isFinite(e.longitude));
  } catch (e) { root.textContent = e.message; }
}

function playTimeline() {
  if (!window.timelineEvents?.length) return alert("No location history to replay yet.");
  if (playbackTimer) clearInterval(playbackTimer);
  let i = 0;
  const marker = L.marker([window.timelineEvents[0].latitude, window.timelineEvents[0].longitude]).addTo(map).bindTooltip("Playback", { permanent: true });
  map.setView(marker.getLatLng(), 15);
  playbackTimer = setInterval(() => {
    const event = window.timelineEvents[i++];
    if (!event) { clearInterval(playbackTimer); playbackTimer = null; map.removeLayer(marker); return; }
    marker.setLatLng([event.latitude, event.longitude]); map.panTo(marker.getLatLng());
  }, 1200);
}

document.getElementById("start").addEventListener("click", () => setSharing(true));
document.getElementById("stop").addEventListener("click", () => setSharing(false));
document.getElementById("historyToggle").addEventListener("change", event => setHistory(event.target.checked));
document.getElementById("deleteHistory").addEventListener("click", deleteHistory);
document.getElementById("playTimeline").addEventListener("click", playTimeline);
document.getElementById("logout").addEventListener("click", () => { if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId); localStorage.removeItem("token"); if (socket) socket.disconnect(); window.location.replace("/login"); });
document.getElementById("friendForm").addEventListener("submit", async event => { event.preventDefault(); try { await api("/friends/request", { method: "POST", body: JSON.stringify({ username: document.getElementById("friendUsername").value.trim() }) }); document.getElementById("friendUsername").value = ""; alert("Friend request sent."); await loadFriends(); } catch (e) { alert(e.message); } });
document.getElementById("askForm").addEventListener("submit", async event => { event.preventDefault(); const answer = document.getElementById("answer"); answer.textContent = "Reva is connecting the dots in your shared location story…"; try { const data = await api("/ask", { method: "POST", body: JSON.stringify({ question: document.getElementById("question").value, aiConsent: document.getElementById("aiConsent").checked }) }); answer.textContent = data.answer; } catch (e) { answer.textContent = e.message; } });
loadFriends();
loadTimeline();
setInterval(() => loadFriends({ quiet: true }), 15000);
setInterval(() => { if (historyEnabled) loadTimeline(); }, 30000);
document.querySelectorAll("[data-question]").forEach(button => button.addEventListener("click", () => { document.getElementById("question").value = button.dataset.question; document.getElementById("question").focus(); }));

document.getElementById("currentLocationPrompt").addEventListener("click", () => {
  document.getElementById("question").value = "Where am I currently?";
  document.getElementById("question").focus();
});