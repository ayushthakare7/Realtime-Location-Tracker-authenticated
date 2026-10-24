"use strict";

// Stable identifiers are part of the API contract. Keep avatar keys exact:
// "bicycle" must never fall through to a generic "cycle" asset.
const TRAVEL_MODES = Object.freeze([
  { id: "walking", label: "Walking", family: "human_powered", avatarKey: "walking", iconKey: "walking", routeProfile: "walking", aliases: ["walk", "walking", "on foot", "by foot", "i am walking", "im walking"] },
  { id: "running", label: "Running", family: "human_powered", avatarKey: "running", iconKey: "running", routeProfile: "walking", aliases: ["run", "running", "jog", "jogging"] },
  { id: "bicycle", label: "Bicycle", family: "human_powered", avatarKey: "bicycle", iconKey: "bicycle", routeProfile: "cycling", aliases: ["bicycle", "bicycling", "by bicycle", "pedal bike", "cycling", "cycle", "by cycle", "on my cycle"] },
  { id: "kick_scooter", label: "Kick scooter", family: "human_powered", avatarKey: "kick_scooter", iconKey: "kick_scooter", routeProfile: "cycling", aliases: ["kick scooter", "push scooter", "scooter without motor"] },
  { id: "skateboard", label: "Skateboard", family: "human_powered", avatarKey: "skateboard", iconKey: "skateboard", routeProfile: "walking", aliases: ["skateboard", "skateboarding"] },
  { id: "roller_skates", label: "Roller skates", family: "human_powered", avatarKey: "roller_skates", iconKey: "roller_skates", routeProfile: "walking", aliases: ["roller skates", "roller skating", "inline skates", "inline skating"] },
  { id: "wheelchair", label: "Wheelchair", family: "accessible_mobility", avatarKey: "wheelchair", iconKey: "wheelchair", routeProfile: "walking", aliases: ["wheelchair", "manual wheelchair", "power wheelchair"] },
  { id: "car", label: "Car", family: "road", avatarKey: "car", iconKey: "car", routeProfile: "driving", aliases: ["car", "by car", "in a car", "driving", "drive", "electric car", "taxi", "cab", "rideshare"] },
  { id: "motorcycle", label: "Motorcycle", family: "road", avatarKey: "motorcycle", iconKey: "motorcycle", routeProfile: "driving", aliases: ["motorcycle", "motorbike", "motor cycle", "motor bike", "bike", "by bike", "on my bike", "riding a bike", "riding motorcycle"] },
  { id: "scooter", label: "Motor scooter", family: "road", avatarKey: "scooter", iconKey: "scooter", routeProfile: "driving", aliases: ["motor scooter", "moped", "scooty", "vespa", "electric scooter", "e-scooter"] },
  { id: "auto_rickshaw", label: "Auto-rickshaw", family: "road", avatarKey: "auto_rickshaw", iconKey: "auto_rickshaw", routeProfile: "driving", aliases: ["auto", "auto rickshaw", "auto-rickshaw", "tuk tuk", "tuk-tuk", "three wheeler", "three-wheeler"] },
  { id: "bus", label: "Bus", family: "road_public_transport", avatarKey: "bus", iconKey: "bus", routeProfile: "driving", aliases: ["bus", "by bus", "coach", "minibus"] },
  { id: "train", label: "Train", family: "rail", avatarKey: "train", iconKey: "train", routeProfile: "transit", aliases: ["train", "by train", "railway", "rail", "high speed train"] },
  { id: "metro", label: "Metro / subway", family: "rail", avatarKey: "metro", iconKey: "metro", routeProfile: "transit", aliases: ["metro", "subway", "underground", "metro train"] },
  { id: "tram", label: "Tram", family: "rail", avatarKey: "tram", iconKey: "tram", routeProfile: "transit", aliases: ["tram", "streetcar", "trolley"] },
  { id: "airplane", label: "Airplane", family: "air", avatarKey: "airplane", iconKey: "airplane", routeProfile: "air", aliases: ["airplane", "plane", "flight", "by air", "aeroplane", "jet"] },
  { id: "helicopter", label: "Helicopter", family: "air", avatarKey: "helicopter", iconKey: "helicopter", routeProfile: "air", aliases: ["helicopter", "chopper"] },
  { id: "boat", label: "Boat", family: "water", avatarKey: "boat", iconKey: "boat", routeProfile: "water", aliases: ["boat", "by boat", "motorboat", "rowboat"] },
  { id: "ferry", label: "Ferry", family: "water_public_transport", avatarKey: "ferry", iconKey: "ferry", routeProfile: "water", aliases: ["ferry", "by ferry", "water bus", "water taxi"] },
  { id: "kayak", label: "Kayak", family: "water", avatarKey: "kayak", iconKey: "kayak", routeProfile: "water", aliases: ["kayak", "kayaking"] },
  { id: "horse", label: "Horse", family: "animal_powered", avatarKey: "horse", iconKey: "horse", routeProfile: "other", aliases: ["horse", "horseback", "on horseback", "riding a horse"] },
  { id: "cable_car", label: "Cable car / gondola", family: "special", avatarKey: "cable_car", iconKey: "cable_car", routeProfile: "transit", aliases: ["cable car", "gondola lift", "cableway", "aerial tramway"] },
  { id: "other", label: "Other transport", family: "other", avatarKey: "other", iconKey: "other", routeProfile: "unknown", aliases: ["other", "other vehicle", "other transport"] }
]);

const BY_ID = new Map(TRAVEL_MODES.map(mode => [mode.id, mode]));

function normalizePhrase(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AMBIGUOUS_BIKE = /\b(bike|by bike|on my bike|riding a bike)\b/i;

function getTravelModeById(id) {
  return BY_ID.get(String(id || "")) || null;
}

/**
 * Resolve only explicit language. "bike" is intentionally ambiguous in
 * everyday speech; ask the user to choose bicycle vs motorcycle rather than
 * selecting an incorrect avatar or routing profile.
 */
function resolveTravelMode(text, selectedModeId = null) {
  if (selectedModeId) {
    const selected = getTravelModeById(selectedModeId);
    return selected
      ? { status: "resolved", mode: selected, source: "user_selection" }
      : { status: "invalid_selection", mode: null, options: ["bicycle", "motorcycle"] };
  }

  const normalized = normalizePhrase(text);
  if (!normalized) return { status: "missing", mode: null, options: TRAVEL_MODES.map(({ id, label }) => ({ id, label })) };

  if (AMBIGUOUS_BIKE.test(normalized)) {
    const bicycleExplicit = /\b(bicycle|cycling|cycle|pedal bike)\b/i.test(normalized);
    const motorExplicit = /\b(motorcycle|motorbike|motor cycle|motor bike)\b/i.test(normalized);
    if (!bicycleExplicit && !motorExplicit) {
      return { status: "clarification_required", mode: null, options: [
        { id: "bicycle", label: "Bicycle", avatarKey: "bicycle" },
        { id: "motorcycle", label: "Motorcycle", avatarKey: "motorcycle" }
      ] };
    }
  }

  const matches = [];
  for (const mode of TRAVEL_MODES) {
    for (const alias of mode.aliases) {
      const candidate = normalizePhrase(alias);
      if (candidate && new RegExp("(^| )" + candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( |$)").test(normalized)) {
        matches.push({ mode, length: candidate.length });
      }
    }
  }
  matches.sort((a, b) => b.length - a.length);
  if (!matches.length) return { status: "clarification_required", mode: null, options: TRAVEL_MODES.map(({ id, label }) => ({ id, label })) };

  const longest = matches[0].length;
  const winners = [...new Map(matches.filter(match => match.length === longest).map(match => [match.mode.id, match.mode])).values()];
  if (winners.length !== 1) {
    return { status: "clarification_required", mode: null, options: winners.map(({ id, label, avatarKey }) => ({ id, label, avatarKey })) };
  }
  return { status: "resolved", mode: winners[0], source: "explicit_language" };
}

function listTravelModes() {
  return TRAVEL_MODES.map(({ id, label, family, avatarKey, iconKey, routeProfile }) => ({
    id, label, family, avatarKey, iconKey, routeProfile
  }));
}

module.exports = { TRAVEL_MODES, getTravelModeById, listTravelModes, resolveTravelMode };
