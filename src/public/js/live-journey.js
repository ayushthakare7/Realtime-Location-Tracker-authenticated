(() => {
  "use strict";
  const token = localStorage.getItem("token");
  if (!token) { window.location.replace("/login"); return; }
  const journeyId = new URLSearchParams(window.location.search).get("id");
  const $ = id => document.getElementById(id);
  const modeNames = { car:"Car", motorcycle:"Motorcycle", scooter:"Scooter", auto_rickshaw:"Auto-rickshaw", bicycle:"Bicycle", walking:"Walking", running:"Running", wheelchair:"Wheelchair", kick_scooter:"Kick scooter", skateboard:"Skateboard", roller_skates:"Roller skates" };
  const vehicleSymbols = { car:"🚗", motorcycle:"🏍️", scooter:"🛵", auto_rickshaw:"🛺", bicycle:"🚲", walking:"🚶", running:"🏃", wheelchair:"♿", kick_scooter:"🛴", skateboard:"🛹", roller_skates:"🛼" };
  let map, routeLayer, startMarker, endMarker, vehicleMarker, lastFixKey = "", animationFrame = null, pollBusy = false, fitOnce = false;
  function apiError(message) { $("mapStatus").textContent = message; $("tripState").textContent = message; }
  async function api(path) {
    const response = await fetch(path, { headers: { Authorization: "Bearer " + localStorage.getItem("token") } });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok || body.success === false) throw new Error(body.message || "Could not load this shared journey.");
    return body;
  }
  function decodePolyline(encoded) {
    let index=0, lat=0, lng=0; const points=[];
    while(index<encoded.length) {
      let result=0, shift=0, byte;
      do { if(index>=encoded.length) throw new Error("Invalid route geometry"); byte=encoded.charCodeAt(index++)-63; result|=(byte&31)<<shift; shift+=5; } while(byte>=32);
      lat += (result&1) ? ~(result>>1) : result>>1;
      result=0; shift=0;
      do { if(index>=encoded.length) throw new Error("Invalid route geometry"); byte=encoded.charCodeAt(index++)-63; result|=(byte&31)<<shift; shift+=5; } while(byte>=32);
      lng += (result&1) ? ~(result>>1) : result>>1;
      points.push([lat/1e5,lng/1e5]);
    }
    return points;
  }
  function validPoint(p) {
    return p && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)) &&
      Number(p.latitude)>=-90 && Number(p.latitude)<=90 && Number(p.longitude)>=-180 && Number(p.longitude)<=180;
  }
  function vehicleIcon(mode, heading=0) {
    const symbol = vehicleSymbols[mode] || "📍";
    return L.divIcon({ className:"live-vehicle-icon-shell", iconSize:[50,50], iconAnchor:[25,25],
      html:'<span class="live-vehicle-icon" aria-label="Live ' + (modeNames[mode] || "journey") + '" style="--vehicle-heading:' + heading + 'deg">' + symbol + '</span>' });
  }
  function endpointIcon(letter, kind) {
    return L.divIcon({ className:"live-endpoint-shell", iconSize:[34,34], iconAnchor:[17,17],
      html:'<span class="live-endpoint live-endpoint-' + kind + '">' + letter + '</span>' });
  }
  function bearing(a,b) {
    const rad = Math.PI/180, y=Math.sin((b[1]-a[1])*rad)*Math.cos(b[0]*rad);
    const x=Math.cos(a[0]*rad)*Math.sin(b[0]*rad)-Math.sin(a[0]*rad)*Math.cos(b[0]*rad)*Math.cos((b[1]-a[1])*rad);
    return Math.atan2(y,x)*180/Math.PI;
  }
  function animateVehicle(from,to,mode) {
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    const start = performance.now(), duration = 2200, heading = bearing(from,to);
    const animate = now => {
      const t=Math.min(1,(now-start)/duration), eased=t*t*(3-2*t);
      const point=[from[0]+(to[0]-from[0])*eased, from[1]+(to[1]-from[1])*eased];
      if (vehicleMarker) { vehicleMarker.setLatLng(point); vehicleMarker.setIcon(vehicleIcon(mode,heading)); }
      if(t<1) animationFrame=requestAnimationFrame(animate); else animationFrame=null;
    };
    animationFrame=requestAnimationFrame(animate);
  }
  function initMap() {
    map = L.map("liveMap", { zoomControl:true, preferCanvas:true }).setView([20.5937,78.9629],5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  }
  function formatEta(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
    return new Date(value).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  }
  function formatStatus(status) {
    return ({ ACTIVE:"Journey in progress", OVERDUE_UNCONFIRMED:"Overdue · check-in needed", ALERT_SENT:"Check-in requested", EMERGENCY_ALERTED:"Emergency alert sent", ARRIVED:"Journey completed" })[status] || String(status || "Status unavailable").replaceAll("_"," ").toLowerCase();
  }
  async function refresh() {
    if (pollBusy || !journeyId) return;
    pollBusy=true;
    try {
      const body=await api("/api/journeys/"+encodeURIComponent(journeyId));
      const j=body.journey;
      if (!j) throw new Error("Journey details were not returned.");
      $("travellerName").textContent=(j.travellerUsername || "Your friend") + "'s journey";
      $("tripState").textContent=formatStatus(j.status);
      $("originLabel").textContent=(j.origin && j.origin.label) || "Starting point A";
      $("destinationLabel").textContent=(j.destination && j.destination.label) || "Destination B";
      $("modeValue").textContent=modeNames[j.transportModeId] || "Travel";
      $("etaValue").textContent=formatEta(j.expectedArrivalAt);
      $("distanceValue").textContent=j.route && Number.isFinite(Number(j.route.distanceMeters)) ? (Number(j.route.distanceMeters)/1000).toFixed(1)+" km" : "—";
      $("routeProvider").textContent=j.route && j.route.provider ? "Route calculated by "+j.route.provider : "Approved journey route";
      const origin=[Number(j.origin.latitude),Number(j.origin.longitude)];
      const destination=[Number(j.destination.latitude),Number(j.destination.longitude)];
      if (!routeLayer && j.route && j.route.encodedPolyline) {
        const points=decodePolyline(j.route.encodedPolyline);
        if(points.length>1) routeLayer=L.polyline(points,{color:"#3f8a67",weight:7,opacity:.9,lineCap:"round",lineJoin:"round"}).addTo(map);
      }
      if (!startMarker) startMarker=L.marker(origin,{icon:endpointIcon("A","start")}).addTo(map).bindTooltip("A · Origin");
      else startMarker.setLatLng(origin);
      if (!endMarker) endMarker=L.marker(destination,{icon:endpointIcon("B","end")}).addTo(map).bindTooltip("B · Destination");
      else endMarker.setLatLng(destination);
      const bounds=[];
      if(routeLayer) bounds.push(...routeLayer.getLatLngs());
      else bounds.push(L.latLng(origin),L.latLng(destination));
      if (!fitOnce && bounds.length) { map.fitBounds(L.latLngBounds(bounds),{padding:[48,48],maxZoom:15}); fitOnce=true; }
      const fix=j.lastConfirmedLocation;
      if(validPoint(fix)) {
        const fixAt=fix.recordedAt || j.updatedAt || null;
        const fixKey=String(fixAt)+"|"+fix.latitude+"|"+fix.longitude;
        const next=[Number(fix.latitude),Number(fix.longitude)];
        if(fixKey!==lastFixKey) {
          if(vehicleMarker) {
            const current=vehicleMarker.getLatLng();
            animateVehicle([current.lat,current.lng],next,j.transportModeId);
          } else {
            vehicleMarker=L.marker(next,{icon:vehicleIcon(j.transportModeId),zIndexOffset:1000}).addTo(map);
            vehicleMarker.bindTooltip((vehicleSymbols[j.transportModeId] || "📍")+" Live position");
          }
          lastFixKey=fixKey;
        }
        const age=Math.max(0,Date.now()-Date.parse(fixAt || Date.now()));
        $("locationFreshness").textContent=age<30000 ? "GPS updated just now" : "Last GPS update "+Math.round(age/60000)+" min ago";
        $("mapStatus").textContent=age<30000 ? "Live location confirmed · updating automatically" : "Showing last confirmed location · waiting for a fresh GPS update";
        if(vehicleMarker && !fitOnce) map.setView(next,15);
      } else {
        $("locationFreshness").textContent="Waiting for the traveller's first GPS fix";
        $("mapStatus").textContent="Approved route shown. Vehicle appears when the first GPS location syncs.";
      }
    } catch(error) {
      apiError(error.message || "Could not refresh the shared journey.");
    } finally { pollBusy=false; }
  }
  if (!journeyId) { $("tripState").textContent="No journey selected"; $("mapStatus").textContent="Open this page from a friend’s shared journey."; }
  else if (!window.L) { apiError("The map library could not load. Check your internet connection."); }
  else { initMap(); refresh(); window.setInterval(refresh,5000); }
})();