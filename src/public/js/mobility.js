(() => {
  const token = localStorage.getItem("token");
  if (!token) { window.location.replace("/login"); return; }

  const $ = id => document.getElementById(id);
  const message = text => { $("mobilityMessage").textContent = text || ""; };
  const api = async (path, options = {}) => {
    const response = await fetch("/api/mobility" + path, {
      ...options,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Mobility request failed.");
    return data;
  };

  const map = L.map("journeyMap", { zoomControl: true, preferCanvas: true }).setView([20.5937, 78.9629], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors", maxZoom: 19
  }).addTo(map);

  const modeIcons = { "driving-car": "🚗", "cycling-regular": "🚲", "foot-walking": "🚶", bus: "🚌", train: "🚆" };
  const modeLabels = { "driving-car": "Car", "cycling-regular": "Bicycle", "foot-walking": "Walking", bus: "Bus", train: "Train" };
  const vehicleIconForMode = mode => L.divIcon({ className: "", html: '<div class="vehicle-marker" aria-label="Your live position">' + (modeIcons[mode] || "📍") + '</div>', iconSize: [42,42], iconAnchor: [21,21] });
  let vehicleIcon = vehicleIconForMode("driving-car");
  const destinationIcon = L.divIcon({ className: "", html: '<div class="destination-marker"><span>●</span></div>', iconSize: [34,34], iconAnchor: [17,34] });
  let vehicleMarker = null, destinationMarker = null, routeLine = null, socket = null;
  let selectedDestination = null, activeTrip = null, latestPosition = null, watchId = null;
  let friendList = [], currentRouteCoordinates = [], pollHandle = null, lastGpsSentAt = 0, lastGpsSent = null, lastRenderedRouteAt = null;
  const sharedTripId = window.REVA_SHARED_TRIP_ID || null;

  const formatDistance = meters => meters >= 1000 ? (meters / 1000).toFixed(meters >= 10000 ? 0 : 1) + " km" : Math.round(meters) + " m";
  const formatDuration = seconds => {
    const mins = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (mins < 60) return mins + " min";
    const hours = Math.floor(mins / 60), remaining = mins % 60;
    return hours + "h" + (remaining ? " " + remaining + "m" : "");
  };
  const formatTime = value => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  const distanceMeters = (a, b) => {
    const rad = v => v * Math.PI / 180;
    const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
    const n = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(n), Math.sqrt(1 - n));
  };

  function updateStatus(trip) {
    if (!trip) {
      $("journeyHeading").textContent = "Ready when you are";
      $("journeyStatus").textContent = "Choose a destination to get started.";
      $("journeyStatus").dataset.state = "";
      $("etaValue").textContent = "—"; $("distanceValue").textContent = "—"; $("durationValue").textContent = "—";
      $("lastLocationInfo").textContent = "Waiting for journey location.";
      $("arrivedButton").disabled = true; $("endJourney").disabled = true;
      return;
    }
    $("journeyHeading").textContent = trip.status === "ARRIVED" ? "You've arrived" : trip.status === "DELAYED" ? "Journey delayed" : "Journey in progress";
    $("journeyStatus").dataset.state = trip.status;
    const copy = {
      ACTIVE: "You're on your way. ETA updates as your location changes.",
      DELAYED: "Your latest expected arrival has passed or shifted beyond the original estimate. Check your route and location signal.",
      ARRIVED: "Arrival confirmed. Your trip is complete.",
      CANCELLED: "This journey was cancelled.",
      COMPLETED: "This journey has ended."
    };
    $("journeyStatus").textContent = copy[trip.status] || trip.status;
    $("etaValue").textContent = formatTime(trip.expectedArrivalAt);
    $("distanceValue").textContent = formatDistance(trip.route?.distanceMeters || 0);
    $("durationValue").textContent = formatDuration(trip.route?.durationSeconds || 0);
    const lastSeen = trip.lastLocation?.lastSeen;
    $("lastLocationInfo").textContent = lastSeen ? "Last GPS update: " + new Date(lastSeen).toLocaleString() : "Waiting for a fresh GPS update.";
    const ongoing = ["ACTIVE", "DELAYED"].includes(trip.status);
    $("arrivedButton").disabled = !ongoing; $("endJourney").disabled = !ongoing;
    $("startJourney").disabled = ongoing;
    $("startJourney").textContent = ongoing ? "Journey in progress" : "Start journey ↗";
    const mode = trip.transportMode || "driving-car";
    vehicleIcon = vehicleIconForMode(mode);
    if (vehicleMarker) vehicleMarker.setIcon(vehicleIcon);
    $("routeSource").textContent = (modeLabels[mode] || "Journey") + (["bus", "train"].includes(mode) ? " · road-network estimate" : " · " + (trip.route?.provider || "road route"));
    $("mapSubtitle").textContent = trip.destination?.label || "Your city, your route";
  }

  function showRoute(trip) {
    if (!trip?.route?.coordinates?.length) return;
    currentRouteCoordinates = trip.route.coordinates.map(point => [Number(point[1]), Number(point[0])]);
    if (routeLine) map.removeLayer(routeLine);
    lastRenderedRouteAt = trip.route.calculatedAt || null;
    routeLine = L.polyline(currentRouteCoordinates, { color: "#4d83c6", weight: 6, opacity: .88, lineCap: "round", lineJoin: "round" }).addTo(map);
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([trip.destination.latitude, trip.destination.longitude], { icon: destinationIcon, keyboard: false }).addTo(map).bindTooltip(trip.destination.label || "Destination");
    if (trip.lastLocation && Number.isFinite(Number(trip.lastLocation.latitude))) setVehiclePosition(trip.lastLocation.latitude, trip.lastLocation.longitude, false);
    const bounds = routeLine.getBounds().extend(destinationMarker.getLatLng());
    const fitZoom = map.getBoundsZoom(bounds, false, L.point(36, 36));
    if (fitZoom < 12) {
      const focus = trip.lastLocation && Number.isFinite(Number(trip.lastLocation.latitude))
        ? [trip.lastLocation.latitude, trip.lastLocation.longitude]
        : [trip.origin.latitude, trip.origin.longitude];
      map.setView(focus, 13, { animate: true });
    } else {
      map.fitBounds(bounds, { paddingTopLeft: [36, 36], paddingBottomRight: [36, 36], maxZoom: 15, animate: true });
    }
    $("mapSubtitle").textContent = trip.destination?.label || "Your route";
  }

  function setVehiclePosition(latitude, longitude, animate = true) {
    const mode = activeTrip?.transportMode || $("transportMode")?.value || "driving-car";
    vehicleIcon = vehicleIconForMode(mode);
    const target = L.latLng(Number(latitude), Number(longitude));
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return;
    if (!vehicleMarker) {
      vehicleMarker = L.marker(target, { icon: vehicleIcon, keyboard: false, zIndexOffset: 1000 }).addTo(map).bindTooltip((modeLabels[mode] || "Your") + " live position");
      if (!activeTrip) map.setView(target, 14);
      return;
    }
    const start = vehicleMarker.getLatLng();
    if (!animate || !start || start.distanceTo(target) > 1500 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      vehicleMarker.setLatLng(target); return;
    }
    const began = performance.now(), duration = 650;
    function frame(now) {
      const t = Math.min(1, (now - began) / duration);
      const eased = t * (2 - t);
      vehicleMarker?.setLatLng([start.lat + (target.lat - start.lat) * eased, start.lng + (target.lng - start.lng) * eased]);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderDestinationResults(results) {
    const root = $("destinationResults"); root.replaceChildren();
    results.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "destination-result"; button.setAttribute("role", "option");
      button.innerHTML = "<strong></strong><small></small>";
      button.querySelector("strong").textContent = item.label;
      button.querySelector("small").textContent = item.latitude.toFixed(5) + ", " + item.longitude.toFixed(5);
      button.addEventListener("click", () => {
        selectedDestination = item;
        $("selectedDestination").textContent = "Destination selected: " + item.label;
        $("destinationQuery").value = item.label;
        root.replaceChildren();
        if (!activeTrip) {
          if (destinationMarker) map.removeLayer(destinationMarker);
          destinationMarker = L.marker([item.latitude, item.longitude], { icon: destinationIcon }).addTo(map).bindTooltip(item.label);
          if (latestPosition) map.fitBounds(L.latLngBounds([[latestPosition.latitude, latestPosition.longitude], [item.latitude, item.longitude]]), { padding: [45,45], maxZoom: 14 });
          else map.setView([item.latitude, item.longitude], 13);
        }
      });
      root.append(button);
    });
    if (!results.length) message("No destination results found. Try a more specific place or address.");
  }

  async function searchDestination() {
    const query = $("destinationQuery").value.trim();
    if (query.length < 3) { message("Enter at least three characters to search for a destination."); return; }
    $("searchDestination").disabled = true; message("Searching destinations…");
    try {
      const data = await api("/geocode?q=" + encodeURIComponent(query));
      renderDestinationResults(data.results || []);
      message((data.results || []).length ? "Choose the correct result to confirm your destination." : "No results found.");
    } catch (error) { message(error.message); }
    finally { $("searchDestination").disabled = false; }
  }

  async function loadFriends() {
    try {
      const data = await fetch("/api/tracker/friends", { headers: { Authorization: "Bearer " + token } }).then(async r => {
        const body = await r.json(); if (!r.ok) throw new Error(body.message || "Could not load friends."); return body;
      });
      friendList = data.friends || [];
      const root = $("friendChoices"); root.replaceChildren();
      friendList.forEach(friend => {
        const label = document.createElement("label"); label.className = "friend-choice";
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = friend.id; checkbox.name = "recipientIds";
        const span = document.createElement("span"); span.textContent = friend.username + (friend.location ? " · sharing on" : " · no live location");
        label.append(checkbox, span); root.append(label);
      });
      if (!friendList.length) root.textContent = "No eligible friends are currently sharing. You can still start a journey.";
    } catch (error) { message("Could not load friends: " + error.message); }
  }

  function recipientSelection() {
    const mode = $("recipientMode").value;
    const recipientIds = [...$("friendChoices").querySelectorAll('input[name="recipientIds"]:checked')].map(input => input.value);
    if (mode === "SELECTED_FRIENDS" && !recipientIds.length) throw new Error("Select at least one friend to receive updates.");
    if (mode === "ONE_FRIEND" && recipientIds.length !== 1) throw new Error("Select exactly one friend to receive updates.");
    return { recipientMode: mode, recipientIds };
  }

  async function startJourney(event) {
    event.preventDefault();
    if (!selectedDestination) { message("Search for a destination and choose one of the results first."); return; }
    if (!latestPosition) { message("Waiting for a GPS fix. Make sure location permission is allowed and location sharing is enabled on the main Reva page."); return; }
    let recipients;
    try { recipients = recipientSelection(); } catch (error) { message(error.message); return; }
    $("startJourney").disabled = true; message("Calculating a road route and initial ETA…");
    try {
      const data = await api("/trips", { method: "POST", body: JSON.stringify({
        destination: selectedDestination,
        transportMode: $("transportMode").value,
        ...recipients
      }) });
      activeTrip = data.trip; updateStatus(activeTrip); showRoute(activeTrip); message("Journey started. Reva is using the road route and your live location.");
      await refreshTrip();
    } catch (error) { message(error.message); $("startJourney").disabled = false; }
  }

  async function refreshTrip() {
    try {
      const data = sharedTripId ? await api("/trips/shared/" + encodeURIComponent(sharedTripId)) : await api("/trips/active");
      if (data.trip) {
        const previousStatus = activeTrip?.status;
        activeTrip = data.trip; updateStatus(activeTrip);
        const routeKey = activeTrip.route?.calculatedAt || null;
        if (!routeLine || routeLine.getLatLngs().length !== (activeTrip.route?.coordinates || []).length || routeKey !== lastRenderedRouteAt) showRoute(activeTrip);
        if (activeTrip.lastLocation && Number.isFinite(Number(activeTrip.lastLocation.latitude))) setVehiclePosition(activeTrip.lastLocation.latitude, activeTrip.lastLocation.longitude, true);
        if (previousStatus && previousStatus !== activeTrip.status) message("Journey status updated: " + activeTrip.status.toLowerCase().replaceAll("_", " ") + ".");
      } else if (sharedTripId) {
        activeTrip = null; updateStatus(null); $("journeyHeading").textContent = "Journey unavailable"; $("journeyStatus").textContent = "This journey is no longer shared with you."; $("journeyStatus").dataset.state = "";
      } else if (!activeTrip || ["ACTIVE","DELAYED"].includes(activeTrip.status)) {
        if (activeTrip && ["ARRIVED","CANCELLED","COMPLETED"].includes(activeTrip.status)) return;
        activeTrip = null; updateStatus(null); $("startJourney").disabled = false;
      }
    } catch (error) {
      $("mobilityConnection").textContent = "Service unavailable";
      message(error.message);
    }
  }

  async function finishTrip(action) {
    if (!activeTrip) return;
    const endpoint = action === "arrive" ? "/trips/" + activeTrip.id + "/arrive" : "/trips/" + activeTrip.id + "/end";
    const body = action === "end" ? { cancel: false } : {};
    try {
      const data = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      activeTrip = data.trip; updateStatus(activeTrip); message(action === "arrive" ? "Arrival confirmed." : "Journey ended.");
    } catch (error) { message(error.message); }
  }

  function sendGps(position) {
    latestPosition = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, recordedAt: new Date() };
    setVehiclePosition(latestPosition.latitude, latestPosition.longitude, true);
    $("mobilityConnection").textContent = "GPS ±" + Math.round(latestPosition.accuracy || 0) + " m";
    if (!socket?.connected) return;
    const moved = !lastGpsSent || distanceMeters(lastGpsSent, latestPosition) >= 30;
    if (moved || Date.now() - lastGpsSentAt >= 15000) {
      socket.emit("send-location", { latitude: latestPosition.latitude, longitude: latestPosition.longitude, accuracyMeters: latestPosition.accuracy });
      lastGpsSent = { latitude: latestPosition.latitude, longitude: latestPosition.longitude };
      lastGpsSentAt = Date.now();
    }
  }

  async function init() {
    $("mobilityConnection").textContent = "Checking sharing…";
    if (sharedTripId) {
      document.querySelector(".journey-form-panel").hidden = true;
      $("arrivedButton").hidden = true; $("endJourney").hidden = true;
      document.querySelector(".mobility-intro h1").innerHTML = "A journey shared<br><em>with you.</em>";
      $("mapSubtitle").textContent = "Shared route";
      socket = io({ auth: { token } });
      socket.on("connect", () => $("mobilityConnection").textContent = "Live connection");
      socket.on("disconnect", () => $("mobilityConnection").textContent = "Reconnecting…");
      socket.on("mobility-trip-update", event => { if (event && String(event.tripId) === String(sharedTripId)) refreshTrip(); });
      socket.on("receive-location", data => {
        if (!activeTrip || !data || String(data.userId) !== String(activeTrip.travellerId)) return;
        setVehiclePosition(data.latitude, data.longitude, true);
        $("lastLocationInfo").textContent = "Live GPS update received" + (data.lastSeen ? " · " + new Date(data.lastSeen).toLocaleTimeString() : "") + (Number.isFinite(Number(data.accuracyMeters)) ? " · ±" + Math.round(Number(data.accuracyMeters)) + " m accuracy" : "");
      });
      await refreshTrip(); pollHandle = setInterval(refreshTrip, 30000); return;
    }
    try {
      const data = await fetch("/api/tracker/friends", { headers: { Authorization: "Bearer " + token } }).then(r => r.json());
      if (!data.sharingEnabled) {
        $("mobilityConnection").textContent = "Sharing is off";
        message("Enable location sharing on the main Reva page first. Your location is off by default.");
      } else {
        socket = io({ auth: { token } });
        socket.on("connect", () => $("mobilityConnection").textContent = "Live connection");
        socket.on("disconnect", () => $("mobilityConnection").textContent = "Reconnecting…");
        socket.on("connect_error", () => { $("mobilityConnection").textContent = "Connection issue"; });
        socket.on("mobility-trip-update", event => { if (event && activeTrip && String(event.tripId) === String(activeTrip.id)) refreshTrip(); });
        if (navigator.geolocation) {
          watchId = navigator.geolocation.watchPosition(sendGps, error => {
            $("mobilityConnection").textContent = "GPS unavailable";
            message(error.code === 1 ? "Location permission was denied. Allow location access in your browser settings." : "Unable to read your location. Check device GPS and retry.");
          }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
        } else message("This browser does not support GPS location.");
      }
      await loadFriends();
      await refreshTrip();
      pollHandle = setInterval(refreshTrip, 30000);
    } catch (error) {
      $("mobilityConnection").textContent = "Service unavailable";
      message(error.message);
    }
  }

  $("transportMode").addEventListener("change", () => {
    if (vehicleMarker && !activeTrip) vehicleMarker.setIcon(vehicleIconForMode($("transportMode").value));
    if (latestPosition && !activeTrip) setVehiclePosition(latestPosition.latitude, latestPosition.longitude, false);
  });
  $("searchDestination").addEventListener("click", searchDestination);
  $("destinationQuery").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); searchDestination(); } });
  $("recipientMode").addEventListener("change", () => { $("friendChoices").hidden = $("recipientMode").value === "ALL_FRIENDS"; });
  $("journeyForm").addEventListener("submit", startJourney);
  $("arrivedButton").addEventListener("click", () => finishTrip("arrive"));
  $("endJourney").addEventListener("click", () => { if (confirm("End this journey now?")) finishTrip("end"); });
  $("recenterMap").addEventListener("click", () => {
    if (activeTrip?.route?.coordinates?.length) showRoute(activeTrip);
    else if (latestPosition) map.setView([latestPosition.latitude, latestPosition.longitude], 15, { animate: true });
  });
  $("logoutMobility")?.addEventListener("click", () => { localStorage.removeItem("token"); window.location.replace("/login"); });
  window.addEventListener("pagehide", () => {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    if (pollHandle) clearInterval(pollHandle);
    socket?.disconnect();
  });
  init();
})();
