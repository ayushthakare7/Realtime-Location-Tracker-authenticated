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

  const modeLabels = { "driving-car": "Car", "cycling-regular": "Bicycle", motorbike: "Bike", "foot-walking": "Walking", bus: "Bus", train: "Train" };
  const modeArt = {
    "driving-car": '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime car"><defs><linearGradient id="carPaint" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#ffb8a5"/><stop offset="1" stop-color="#ed6e69"/></linearGradient></defs><ellipse cx="48" cy="72" rx="35" ry="5" fill="#263d3a" opacity=".13"/><path d="M15 49l5-15q2-6 10-7h35q7 1 11 8l6 14q5 2 5 8v7H9v-8q0-5 6-7z" fill="url(#carPaint)" stroke="#263d3a" stroke-width="3" stroke-linejoin="round"/><path d="M28 31h13v15H20l4-11q1-4 4-4zm18 0h16q5 1 8 7l3 8H46z" fill="#c9f1f5" stroke="#263d3a" stroke-width="2.5" stroke-linejoin="round"/><path d="M37 48h22" stroke="#263d3a" stroke-width="2.5" stroke-linecap="round"/><circle cx="27" cy="62" r="8" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><circle cx="69" cy="62" r="8" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><circle cx="43" cy="51" r="2.7" fill="#263d3a"/><circle cx="54" cy="51" r="2.7" fill="#263d3a"/><path d="M45 56q4 4 8 0" fill="none" stroke="#263d3a" stroke-width="2" stroke-linecap="round"/><path d="M8 22l3 5 5 2-5 2-3 5-2-5-5-2 5-2zM79 13l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#f3c85e" stroke="#263d3a" stroke-width="1.5"/></svg>',
    "cycling-regular": '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime cyclist"><ellipse cx="48" cy="73" rx="35" ry="4" fill="#263d3a" opacity=".12"/><circle cx="20" cy="57" r="14" fill="#fffdf5" stroke="#405d56" stroke-width="3"/><circle cx="75" cy="57" r="14" fill="#fffdf5" stroke="#405d56" stroke-width="3"/><circle cx="20" cy="57" r="3" fill="#f08c76"/><circle cx="75" cy="57" r="3" fill="#f08c76"/><path d="M20 57l15-22 15 22H20l13-1 9-18 14 19h19L63 35H48" fill="none" stroke="#4d83c6" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 28q-2-10 8-14 11-3 15 7l-1 9-10 5-10-2z" fill="#f6c9a8" stroke="#263d3a" stroke-width="2.5"/><path d="M34 24q-1-13 11-15 12-1 16 11l-6-3-7 1-7-3z" fill="#5b4c6d" stroke="#263d3a" stroke-width="2.5"/><circle cx="44" cy="27" r="2.2" fill="#263d3a"/><circle cx="53" cy="26" r="2.2" fill="#263d3a"/><path d="M45 32q4 3 7-1" fill="none" stroke="#b75e61" stroke-width="1.8" stroke-linecap="round"/><path d="M41 36l-7 9 13 5 9-13-7-3z" fill="#78b7a0" stroke="#263d3a" stroke-width="2.5" stroke-linejoin="round"/><path d="M39 42l-7 8M50 43l8 9" stroke="#263d3a" stroke-width="3" stroke-linecap="round"/><path d="M5 17l3 5 5 1-5 2-3 5-2-5-4-2 4-1z" fill="#f3c85e"/></svg>',
    motorbike: '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime motorbike"><ellipse cx="48" cy="72" rx="34" ry="5" fill="#263d3a" opacity=".13"/><circle cx="22" cy="61" r="10" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><circle cx="22" cy="61" r="3" fill="#f3c85e"/><circle cx="74" cy="61" r="10" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><circle cx="74" cy="61" r="3" fill="#f3c85e"/><path d="M22 60l13-17h19l20 18H48l-13-17 10-8h12l8 10" fill="none" stroke="#3f8178" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 40q7-10 18-7l10 10-12 7-15-2z" fill="#f08c76" stroke="#263d3a" stroke-width="2.7" stroke-linejoin="round"/><path d="M39 32q-3-12 8-16 12-3 17 9l-5 7-9-6-6 6z" fill="#5b4c6d" stroke="#263d3a" stroke-width="2.7" stroke-linejoin="round"/><circle cx="48" cy="28" r="2.2" fill="#263d3a"/><circle cx="57" cy="27" r="2.2" fill="#263d3a"/><path d="M49 33q4 3 7-1" fill="none" stroke="#b75e61" stroke-width="1.8" stroke-linecap="round"/><path d="M58 39l9-7 7 2M35 42l-9-5" stroke="#263d3a" stroke-width="4" stroke-linecap="round"/><path d="M8 18l3 5 5 2-5 2-3 5-2-5-5-2 5-2zM82 11l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#f3c85e" stroke="#263d3a" stroke-width="1.5"/></svg>',
    "foot-walking": '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime walking character"><ellipse cx="48" cy="74" rx="24" ry="4" fill="#263d3a" opacity=".12"/><path d="M34 42l-5 18-12 5q-3 3 1 5h19l7-21M55 43l8 17 11 4q5 4 0 6H56l-9-19" fill="#f6c9a8" stroke="#263d3a" stroke-width="2.7" stroke-linejoin="round"/><path d="M30 36q-2-12 7-16 12-5 20 5l3 19-10 8-17-6z" fill="#8b9de5" stroke="#263d3a" stroke-width="2.7"/><path d="M34 26q-3-14 9-17 12-3 18 8l-4 7-7-6-10 4z" fill="#5b4c6d" stroke="#263d3a" stroke-width="2.7"/><ellipse cx="42" cy="30" rx="3" ry="4" fill="#263d3a"/><ellipse cx="53" cy="29" rx="3" ry="4" fill="#263d3a"/><circle cx="40" cy="35" r="3" fill="#ee8f91" opacity=".8"/><circle cx="56" cy="34" r="3" fill="#ee8f91" opacity=".8"/><path d="M44 37q4 3 7-1" fill="none" stroke="#b75e61" stroke-width="1.8" stroke-linecap="round"/><path d="M34 42l-9 11-6-2M56 42l8 10 8-2" fill="none" stroke="#263d3a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 21l3 5 5 2-5 2-3 5-2-5-5-2 5-2zM78 12l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#f3c85e"/></svg>',
    bus: '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime bus"><ellipse cx="48" cy="73" rx="32" ry="4" fill="#263d3a" opacity=".12"/><path d="M20 12h56q7 0 7 8v39q0 5-6 5H19q-6 0-6-6V20q0-8 7-8z" fill="#f4c95d" stroke="#263d3a" stroke-width="3"/><path d="M20 19h56v20H20z" fill="#c9f1f5" stroke="#263d3a" stroke-width="2.5"/><path d="M32 20v18M45 20v18M58 20v18M71 20v18" stroke="#263d3a" stroke-width="2"/><path d="M17 44h62v13H17z" fill="#ef8e78" stroke="#263d3a" stroke-width="2.5"/><circle cx="31" cy="49" r="2.8" fill="#263d3a"/><circle cx="44" cy="49" r="2.8" fill="#263d3a"/><path d="M33 54q5 4 9 0" fill="none" stroke="#263d3a" stroke-width="2" stroke-linecap="round"/><circle cx="27" cy="64" r="7" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><circle cx="69" cy="64" r="7" fill="#344a49" stroke="#fff5e9" stroke-width="3"/><path d="M8 15l3 5 5 2-5 2-3 5-2-5-5-2 5-2zM83 8l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#f3c85e" stroke="#263d3a" stroke-width="1.5"/></svg>',
    train: '<svg viewBox="0 0 96 82" role="img" aria-label="Cute anime train"><ellipse cx="48" cy="73" rx="31" ry="4" fill="#263d3a" opacity=".12"/><path d="M26 8h44q10 0 10 12v37q0 7-8 7H24q-8 0-8-7V20Q16 8 26 8z" fill="#8bc7b3" stroke="#263d3a" stroke-width="3"/><path d="M25 16h46q3 0 3 4v18H22V20q0-4 3-4z" fill="#c9f1f5" stroke="#263d3a" stroke-width="2.5"/><path d="M47 17v19" stroke="#263d3a" stroke-width="2.5"/><circle cx="38" cy="45" r="2.8" fill="#263d3a"/><circle cx="57" cy="45" r="2.8" fill="#263d3a"/><path d="M40 51q7 5 13 0" fill="none" stroke="#263d3a" stroke-width="2.2" stroke-linecap="round"/><path d="M23 57h50" stroke="#f5d77d" stroke-width="5" stroke-linecap="round"/><circle cx="29" cy="64" r="5" fill="#344a49" stroke="#fff5e9" stroke-width="2"/><circle cx="67" cy="64" r="5" fill="#344a49" stroke="#fff5e9" stroke-width="2"/><path d="M8 21l3 5 5 2-5 2-3 5-2-5-5-2 5-2zM81 12l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" fill="#f3c85e" stroke="#263d3a" stroke-width="1.5"/></svg>'
  };
  // Use the exact same SVG source in the mode cards and the live map marker.
  document.querySelectorAll(".transport-mode-card").forEach(card => {
    const art = card.querySelector(".mode-art");
    const illustration = modeArt[card.dataset.mode];
    if (art && illustration) art.innerHTML = illustration;
  });
  const vehicleIconForMode = mode => L.divIcon({ className: "vehicle-icon-shell", html: '<div class="vehicle-marker vehicle-marker-' + (mode || "driving-car") + '">' + (modeArt[mode] || modeArt["driving-car"]) + '</div>', iconSize: [74,64], iconAnchor: [37,32] });
  let vehicleIcon = vehicleIconForMode("driving-car");
  const destinationIcon = L.divIcon({ className: "", html: '<div class="destination-marker"><span>●</span></div>', iconSize: [34,34], iconAnchor: [17,34] });
  let vehicleMarker = null, animationMarker = null, destinationMarker = null, routeLine = null, animationGuideLine = null, socket = null;
  let selectedDestination = null, activeTrip = null, latestPosition = null, watchId = null, vehiclePreviewEnabled = false, journeyAnimationRunning = false, pageRefreshScheduled = false, locationSharingEnabled = false;
  let mapPickMode = false, pendingMapDestination = null, mapPickMarker = null;
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
    const tripOngoing = Boolean(trip && ["ACTIVE", "DELAYED"].includes(trip.status));
    if (tripOngoing) setMapPickMode(false);
    $("pickDestinationOnMap").disabled = tripOngoing;
    if (!trip) {
      $("journeyHeading").textContent = "Ready when you are";
      $("journeyStatus").textContent = "Choose a destination to get started.";
      $("journeyStatus").dataset.state = "";
      $("etaValue").textContent = "—"; $("distanceValue").textContent = "—"; $("durationValue").textContent = "—";
      $("lastLocationInfo").textContent = "Waiting for journey location.";
      $("arrivedButton").disabled = true; $("endJourney").disabled = true;
      return;
    }
    const isSharedView = Boolean(sharedTripId);
    const travellerName = String(trip.travellerUsername || trip.username || "Your friend").trim() || "Your friend";
    $("journeyHeading").textContent = isSharedView
      ? trip.status === "ARRIVED" ? travellerName + " has arrived" : trip.status === "DELAYED" ? travellerName + "'s journey is delayed" : ["COMPLETED", "CANCELLED"].includes(trip.status) ? travellerName + "'s journey has ended" : travellerName + "'s journey in progress"
      : trip.status === "ARRIVED" ? "You've arrived" : trip.status === "DELAYED" ? "Journey delayed" : "Journey in progress";
    $("journeyStatus").dataset.state = trip.status;
    const copy = isSharedView ? {
      ACTIVE: travellerName + " is on the way. Their ETA updates as their location changes.",
      DELAYED: travellerName + "'s expected arrival has shifted or is delayed. Check their shared route for updates.",
      ARRIVED: travellerName + " has arrived at their destination. Their journey is complete.",
      CANCELLED: travellerName + "'s journey was cancelled.",
      COMPLETED: travellerName + "'s journey has ended."
    } : {
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

  function normalizeRouteCoordinates(rawCoordinates, origin, destination) {
    if (!Array.isArray(rawCoordinates)) return [];
    const candidates = [
      rawCoordinates.map(point => Array.isArray(point) ? [Number(point[1]), Number(point[0])] : [Number(point?.latitude), Number(point?.longitude)]),
      rawCoordinates.map(point => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point?.latitude), Number(point?.longitude)])
    ].map(points => points.filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1])
      && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180));

    if (candidates[0].length < 2) return candidates[1].length >= 2 ? candidates[1] : [];
    if (candidates[1].length < 2) return candidates[0];
    const distance = (a, b) => {
      if (!a || !b) return 0;
      const lat = (a[0] - b[0]) * Math.PI / 180;
      const lon = (a[1] - b[1]) * Math.PI / 180;
      return lat * lat + lon * lon * Math.cos((a[0] + b[0]) * Math.PI / 360) ** 2;
    };
    const score = points => distance(points[0], origin) + distance(points[points.length - 1], destination);
    return score(candidates[0]) <= score(candidates[1]) ? candidates[0] : candidates[1];
  }

  function showRoute(trip) {
    if (!trip?.route?.coordinates?.length) return;
    if (animationGuideLine) { map.removeLayer(animationGuideLine); animationGuideLine = null; }
    currentRouteCoordinates = normalizeRouteCoordinates(trip.route.coordinates, [Number(trip.origin?.latitude), Number(trip.origin?.longitude)], [Number(trip.destination?.latitude), Number(trip.destination?.longitude)]);
    if (currentRouteCoordinates.length < 2) return;
    if (routeLine) map.removeLayer(routeLine);
    lastRenderedRouteAt = trip.route.calculatedAt || null;
    routeLine = L.polyline(currentRouteCoordinates, { color: "#263746", weight: 7, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(map);
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([trip.destination.latitude, trip.destination.longitude], { icon: destinationIcon, keyboard: false }).addTo(map).bindTooltip(trip.destination.label || "Destination");
    if (trip.lastLocation && Number.isFinite(Number(trip.lastLocation.latitude))) setVehiclePosition(trip.lastLocation.latitude, trip.lastLocation.longitude, false);
    const bounds = routeLine.getBounds().extend(destinationMarker.getLatLng());
    const fitZoom = map.getBoundsZoom(bounds, false, L.point(36, 36));
    if (fitZoom < 12) {
      const focus = trip.lastLocation && Number.isFinite(Number(trip.lastLocation.latitude))
        ? [trip.lastLocation.latitude, trip.lastLocation.longitude]
        : [trip.origin.latitude, trip.origin.longitude];
      map.setView(focus, 13, { animate: false });
    } else {
      map.fitBounds(bounds, { paddingTopLeft: [36, 36], paddingBottomRight: [36, 36], maxZoom: 15, animate: false });
    }
    $("mapSubtitle").textContent = trip.destination?.label || "Your route";
  }


  function setVehiclePosition(latitude, longitude, animate = true) {
    // During planning, show the current position only after the user explicitly selects a vehicle.
    // A vehicle selection must never create or restore a destination marker.
    if (!activeTrip && !sharedTripId && !vehiclePreviewEnabled) return;
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

  function setMapPickMode(enabled) {
    mapPickMode = Boolean(enabled) && !activeTrip;
    $("mapPickActions").hidden = !mapPickMode;
    $("pickDestinationOnMap").textContent = mapPickMode ? "⌖ Map selection active" : "⌖ Pick on Map";
    $("pickDestinationOnMap").disabled = Boolean(activeTrip);
    $("destinationQuery").disabled = mapPickMode;
    $("searchDestination").disabled = mapPickMode;
    $("destinationResults").replaceChildren();
    map.getContainer().classList.toggle("map-pick-active", mapPickMode);
    if (!mapPickMode) {
      pendingMapDestination = null;
      $("confirmMapDestination").disabled = true;
      if (mapPickMarker) { map.removeLayer(mapPickMarker); mapPickMarker = null; }
    } else {
      $("selectedDestination").textContent = "Tap a point on the map. Zoom and pan to find the exact place.";
      message("Map selection mode is on. Tap the map to place a destination pin.");
    }
  }

  map.on("click", event => {
    if (!mapPickMode || activeTrip) return;
    const latitude = Number(event.latlng.lat.toFixed(6));
    const longitude = Number(event.latlng.lng.toFixed(6));
    pendingMapDestination = {
      label: "Pinned destination (" + latitude.toFixed(5) + ", " + longitude.toFixed(5) + ")",
      latitude,
      longitude
    };
    if (mapPickMarker) map.removeLayer(mapPickMarker);
    mapPickMarker = L.marker([latitude, longitude], { icon: destinationIcon, keyboard: false }).addTo(map)
      .bindTooltip("Selected map point").openTooltip();
    $("confirmMapDestination").disabled = false;
    $("selectedDestination").textContent = "Map point ready: " + latitude.toFixed(5) + ", " + longitude.toFixed(5) + ". Choose “Use This Destination” to confirm.";
    message("Destination pin placed. Confirm it or tap another point to move the pin.");
  });

  function confirmMapDestination() {
    if (!pendingMapDestination) return;
    selectedDestination = { ...pendingMapDestination };
    $("destinationQuery").value = selectedDestination.label;
    $("selectedDestination").textContent = "Destination selected: " + selectedDestination.label;
    if (destinationMarker) map.removeLayer(destinationMarker);
    destinationMarker = L.marker([selectedDestination.latitude, selectedDestination.longitude], { icon: destinationIcon, keyboard: false })
      .addTo(map).bindTooltip(selectedDestination.label);
    setMapPickMode(false);
    $("selectedDestination").textContent = "Destination selected: " + selectedDestination.label;
    message("Map destination confirmed. Start journey when you're ready.");
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
    if (mapPickMode) { message("Confirm or cancel your map selection before starting the journey."); return; }
    if (!selectedDestination) { message("Search for a destination and choose a result, or use Pick on Map to select a point."); return; }
    if (!locationSharingEnabled) {
      try { sessionStorage.setItem("reva.pendingJourneyDestination", JSON.stringify(selectedDestination)); } catch (_) {}
      window.location.assign("/tracker?returnTo=%2Fmobility");
      return;
    }
    if (!latestPosition) { message("Location sharing is enabled, but GPS is still getting your position. Wait a moment and try again."); return; }
    let recipients;
    try { recipients = recipientSelection(); } catch (error) { message(error.message); return; }
    $("startJourney").disabled = true; message("Calculating a road route and initial ETA…");
    try {
      const data = await api("/trips", { method: "POST", body: JSON.stringify({
        destination: selectedDestination,
        transportMode: $("transportMode").value,
        ...recipients
      }) });
      activeTrip = data.trip;
      setMapPickMode(false);
      updateStatus(activeTrip);

      // No cinematic animation: immediately draw the full solid road route and both markers.
      if (activeTrip?.route?.coordinates?.length) {
        showRoute(activeTrip);
        updateStatus(activeTrip);
        map.invalidateSize();
      }
      await refreshTrip();
      if (activeTrip?.route?.coordinates?.length) {
        showRoute(activeTrip);
        updateStatus(activeTrip);
        map.invalidateSize();
      }
      message("Journey started. Your route, current location and destination are shown on the map.");

      // Move straight to Live Journey so ETA, distance, travel time and journey actions are visible.
      const progressPanel = document.querySelector(".journey-status-panel");
      if (progressPanel) {
        progressPanel.setAttribute("tabindex", "-1");
        progressPanel.style.scrollMarginTop = "18px";
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const top = progressPanel.getBoundingClientRect().top + window.scrollY - 18;
        window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
        progressPanel.focus({ preventScroll: true });
      }
    } catch (error) { message(error.message); $("startJourney").disabled = false; }
  }

  async function refreshTrip() {
    // Do not let polling/socket refreshes replace the animated route mid-playback.
    if (journeyAnimationRunning) return;
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
      } else if (!sharedTripId) {
        // The worker may have auto-marked the trip ARRIVED, so /trips/active now returns no trip.
        if (activeTrip && ["ACTIVE", "DELAYED"].includes(activeTrip.status)) {
          message("Your journey has ended. Refreshing the page for your next journey…");
          schedulePageRefresh(900);
          return;
        }
        // No active trip means the previous ride is over. Reset the page for a new journey.
        activeTrip = null;
        vehiclePreviewEnabled = false;
        if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
        if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
        if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }
        currentRouteCoordinates = [];
        lastRenderedRouteAt = null;
        selectedDestination = null;
        pendingMapDestination = null;
        $("destinationQuery").value = "";
        $("selectedDestination").textContent = "Your destination will appear here.";
        $("etaValue").textContent = "—";
        $("distanceValue").textContent = "—";
        $("durationValue").textContent = "—";
        $("lastLocationInfo").textContent = "Waiting for journey location.";
        $("journeyHeading").textContent = "Ready when you are";
        $("journeyStatus").textContent = "Choose a vehicle and destination to start a new journey.";
        $("journeyStatus").dataset.state = "";
        $("arrivedButton").disabled = true;
        $("endJourney").disabled = true;
        $("startJourney").disabled = false;
        $("startJourney").textContent = "Start journey ↗";
        $("routeSource").textContent = "Route will appear after you start.";
        $("mapSubtitle").textContent = "Your city, your route";
      }
    } catch (error) {
      $("mobilityConnection").textContent = "Service unavailable";
      message(error.message);
    }
  }

  function schedulePageRefresh(delay = 900) {
    if (pageRefreshScheduled) return;
    pageRefreshScheduled = true;
    window.setTimeout(() => window.location.reload(), delay);
  }

  async function finishTrip(action) {
    if (!activeTrip) return;
    const endpoint = action === "arrive" ? "/trips/" + activeTrip.id + "/arrive" : "/trips/" + activeTrip.id + "/end";
    const body = action === "end" ? { cancel: false } : {};
    $("arrivedButton").disabled = true;
    $("endJourney").disabled = true;
    try {
      const data = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
      activeTrip = data.trip;
      updateStatus(activeTrip);
      message(action === "arrive" ? "Arrival confirmed. Refreshing the page…" : "Journey ended. Refreshing the page…");
      schedulePageRefresh(900);
    } catch (error) {
      $("arrivedButton").disabled = false;
      $("endJourney").disabled = false;
      message(error.message);
    }
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
      $("journeyForm").hidden = true;
      $("arrivedButton").hidden = true; $("endJourney").hidden = true;
      $("journeyHeading").textContent = "A journey shared with you";
      $("journeyStatus").textContent = "Viewing a friend's shared journey.";
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
      locationSharingEnabled = Boolean(data.sharingEnabled);
      if (!locationSharingEnabled) {
        $("mobilityConnection").textContent = "Sharing is off";
        message("Location sharing is off. Start Journey will take you to Reva to enable it first.");
      } else {
        // Restore the destination when returning from the main Reva sharing page.
        if (new URLSearchParams(window.location.search).get("resumeJourney") === "1") {
          try {
            const saved = sessionStorage.getItem("reva.pendingJourneyDestination");
            if (saved) {
              selectedDestination = JSON.parse(saved);
              $("destinationQuery").value = selectedDestination.label || "";
              $("selectedDestination").textContent = "Selected destination: " + (selectedDestination.label || "Destination");
              sessionStorage.removeItem("reva.pendingJourneyDestination");
            }
          } catch (_) {}
        }
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

  function syncTransportModeCards() {
    const mode = $("transportMode").value;
    document.querySelectorAll(".transport-mode-card").forEach(card => {
      const selected = card.dataset.mode === mode;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-pressed", String(selected));
    });
    // Selecting a vehicle previews the chosen vehicle at the user's current GPS position.
    // Keep destination pins out of this action; they belong to explicit destination selection.
    if (vehicleMarker && activeTrip) {
      vehicleMarker.setIcon(vehicleIconForMode(mode));
    } else if (!sharedTripId) {
      vehiclePreviewEnabled = true;
      if (latestPosition) {
        setVehiclePosition(latestPosition.latitude, latestPosition.longitude, false);
        map.setView([latestPosition.latitude, latestPosition.longitude], 16, { animate: true, duration: 0.7 });
      }
    }
  }
  document.querySelectorAll(".transport-mode-card").forEach(card => {
    card.addEventListener("click", () => {
      $("transportMode").value = card.dataset.mode;
      syncTransportModeCards();
      if (sharedTripId) return;
      message((modeLabels[card.dataset.mode] || "Vehicle") + " selected. Continue to Plan a Journey below.");
      const destinationPanel = document.querySelector(".destination-panel");
      destinationPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      destinationPanel?.classList.add("plan-next-highlight");
      window.setTimeout(() => destinationPanel?.classList.remove("plan-next-highlight"), 1400);
    });
  });
  $("transportMode").addEventListener("change", syncTransportModeCards);
  $("searchDestination").addEventListener("click", searchDestination);
  $("pickDestinationOnMap").addEventListener("click", () => setMapPickMode(!mapPickMode));
  $("confirmMapDestination").addEventListener("click", confirmMapDestination);
  $("cancelMapPick").addEventListener("click", () => {
    setMapPickMode(false);
    $("selectedDestination").textContent = selectedDestination
      ? "Destination selected: " + selectedDestination.label
      : "Search for a place or pick a point directly on the map.";
    message("Map selection cancelled.");
  });
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
