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
let sharing = false;
let watchId = null;
let socket;

function setStatus(message) { document.getElementById("status").textContent = message; }
function upsertMarker(data) {
  if (!data || !Number.isFinite(Number(data.latitude)) || !Number.isFinite(Number(data.longitude))) return;
  const id = String(data.userId || data.username);
  const point = [Number(data.latitude), Number(data.longitude)];
  if (markers.has(id)) markers.get(id).setLatLng(point);
  else {
    const marker = L.marker(point).addTo(map).bindTooltip(data.username || "Friend", { permanent: true, direction: "top" });
    markers.set(id, marker);
  }
}
function removeMarker(id) {
  const marker = markers.get(String(id));
  if (marker) map.removeLayer(marker);
  markers.delete(String(id));
}
function connectSocket() {
  socket = io({ auth: { token } });
  socket.on("connect", () => setStatus("Connected. Location sharing is " + (sharing ? "on." : "off.")));
  socket.on("connect_error", error => setStatus("Socket connection: " + error.message));
  socket.on("sharing-status", data => { if (!sharing) setStatus(data.enabled ? "Your sharing is enabled on this account." : "Sharing is off until you opt in."); });
  socket.on("receive-location", data => upsertMarker(data));
  socket.on("sharing-stopped", data => { if (data && data.userId) removeMarker(data.userId); });
}
connectSocket();

async function loadFriends() {
  try {
    const data = await api("/friends");
    const friendRoot = document.getElementById("friends");
    friendRoot.replaceChildren();
    if (!data.friends.length) friendRoot.textContent = "No accepted friends yet.";
    data.friends.forEach(friend => {
      const item = document.createElement("div");
      item.className = "friend";
      const title = document.createElement("strong");
      title.textContent = friend.username;
      const detail = document.createElement("div");
      detail.className = "muted";
      detail.textContent = friend.sharingEnabled ? "Sharing enabled" : "Not sharing";
      item.append(title, detail);
      friendRoot.append(item);
      if (friend.location) upsertMarker({ ...friend.location, userId: friend.id, username: friend.username });
      else removeMarker(friend.id);
    });
    const requestRoot = document.getElementById("requests");
    requestRoot.replaceChildren();
    if (data.requests.length) {
      const heading = document.createElement("h4");
      heading.textContent = "Incoming requests";
      requestRoot.append(heading);
      data.requests.forEach(request => {
        const row = document.createElement("div");
        row.className = "friend";
        const label = document.createElement("span");
        label.textContent = request.username + " ";
        const accept = document.createElement("button");
        accept.textContent = "Accept";
        accept.onclick = async () => { try { await api("/friends/requests/" + request.id + "/respond", { method: "POST", body: JSON.stringify({ status: "accepted" }) }); await loadFriends(); } catch (e) { alert(e.message); } };
        const decline = document.createElement("button");
        decline.textContent = "Decline";
        decline.className = "secondary";
        decline.onclick = async () => { try { await api("/friends/requests/" + request.id + "/respond", { method: "POST", body: JSON.stringify({ status: "declined" }) }); await loadFriends(); } catch (e) { alert(e.message); } };
        row.append(label, accept, decline);
        requestRoot.append(row);
      });
    }
    sharing = Boolean(data.sharingEnabled);
    setStatus(sharing ? "Sharing is enabled. Accepted friends can see your latest location." : "Sharing is off. Your location is not being broadcast.");
  } catch (e) { setStatus(e.message); }
}

async function setSharing(enabled) {
  try {
    const data = await api("/sharing", { method: "PATCH", body: JSON.stringify({ enabled }) });
    sharing = data.sharingEnabled;
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (sharing) {
      if (!navigator.geolocation) throw new Error("This browser does not support geolocation.");
      watchId = navigator.geolocation.watchPosition(position => {
        if (socket && socket.connected && sharing) socket.emit("send-location", { latitude: position.coords.latitude, longitude: position.coords.longitude });
      }, error => setStatus("Location permission/error: " + error.message), { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });
      setStatus("Sharing enabled. Your browser may ask for location permission.");
    } else {
      setStatus("Sharing stopped. Your saved latest location and history were cleared.");
      markers.forEach((marker, id) => { if (id === "me") removeMarker(id); });
    }
    await loadFriends();
  } catch (e) { setStatus(e.message); }
}

document.getElementById("start").addEventListener("click", () => setSharing(true));
document.getElementById("stop").addEventListener("click", () => setSharing(false));
document.getElementById("logout").addEventListener("click", () => {
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  localStorage.removeItem("token");
  if (socket) socket.disconnect();
  window.location.replace("/login");
});
document.getElementById("friendForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await api("/friends/request", { method: "POST", body: JSON.stringify({ username: document.getElementById("friendUsername").value.trim() }) });
    document.getElementById("friendUsername").value = "";
    alert("Friend request sent.");
    await loadFriends();
  } catch (e) { alert(e.message); }
});
document.getElementById("askForm").addEventListener("submit", async event => {
  event.preventDefault();
  const answer = document.getElementById("answer");
  answer.textContent = "Asking Gemini…";
  try {
    const data = await api("/ask", { method: "POST", body: JSON.stringify({ question: document.getElementById("question").value }) });
    answer.textContent = data.answer;
  } catch (e) { answer.textContent = e.message; }
});
loadFriends();
