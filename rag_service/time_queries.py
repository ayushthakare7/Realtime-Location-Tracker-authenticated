"""Deterministic answers for time-specific location questions.

All database reads are restricted to IDs authorized by the Node.js API layer.
"""
import re
from bisect import bisect_left
from datetime import datetime, timedelta, timezone, time as datetime_time
from math import radians, sin, cos, sqrt, atan2
from zoneinfo import ZoneInfo

LOCAL_TZ = ZoneInfo("Asia/Kolkata")


def _bounds(day):
    start = datetime.combine(day, datetime_time.min, tzinfo=LOCAL_TZ)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def _distance_m(a_lat, a_lon, b_lat, b_lon):
    d_lat = radians(b_lat - a_lat)
    d_lon = radians(b_lon - a_lon)
    a = sin(d_lat / 2) ** 2 + cos(radians(a_lat)) * cos(radians(b_lat)) * sin(d_lon / 2) ** 2
    return 6371000 * 2 * atan2(sqrt(a), sqrt(max(0.0, 1 - a)))


def _requested_clock(question, now, extracted_intent=None):
    extracted_intent = extracted_intent or {}
    time_text = extracted_intent.get("time_text") if isinstance(extracted_intent, dict) else None
    source = str(time_text or question)
    match = re.search(r"(?:\b(?:at|around|about)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b", source, re.I)
    if not match:
        return None
    hour, minute = int(match.group(1)), int(match.group(2) or 0)
    meridiem = match.group(3).lower().replace(".", "")
    if not 1 <= hour <= 12 or minute > 59:
        return None
    hour = hour % 12 + (12 if meridiem == "pm" else 0)
    day = now.date()
    date_text = str(extracted_intent.get("date_text") or question)
    if re.search(r"\bday before yesterday\b", date_text, re.I):
        day -= timedelta(days=2)
    elif re.search(r"\byesterday\b|\blast night\b", date_text, re.I):
        day -= timedelta(days=1)
    elif not re.search(r"\btoday\b", date_text, re.I):
        candidate = datetime.combine(day, datetime_time(hour, minute), tzinfo=LOCAL_TZ)
        if candidate > now:
            day -= timedelta(days=1)
    return datetime.combine(day, datetime_time(hour, minute), tzinfo=LOCAL_TZ)


def _as_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def answer_time_question(question, authorized_user_ids, context, database, extracted_intent=None):
    """Answer open-ended temporal location questions from authorized timestamped evidence."""
    extracted_intent = extracted_intent or {}
    intent = extracted_intent.get("intent", "other")
    ids = [str(value) for value in authorized_user_ids if re.fullmatch(r"[a-fA-F0-9]{24}", str(value))]
    current_id = str(context.get("currentUserId") or "")
    if not re.fullmatch(r"[a-fA-F0-9]{24}", current_id):
        return None
    if current_id not in ids:
        if re.search(r"\b(?:i|me|my)\b", question, re.I):
            return "I can't answer from your personal history because location history is unavailable or disabled."
        return None

    # "When were we closest today/yesterday?" compares contemporaneous GPS samples.
    if (intent == "closest_people"
            or (re.search(r"\b(?:closer|closest|nearest)\b", question, re.I)
                and re.search(r"\b(?:today|yesterday)\b", question, re.I))):
        date_text = str(extracted_intent.get("date_text") or question).lower()
        day = datetime.now(LOCAL_TZ).date()
        if "day before yesterday" in date_text:
            day -= timedelta(days=2)
        elif "yesterday" in date_text or "last night" in date_text:
            day -= timedelta(days=1)
        start, end = _bounds(day)
        points = database["locationpoints"]
        mine = list(points.find({"userId": _oid(current_id), "recordedAt": {"$gte": start, "$lt": end}},
                                {"recordedAt": 1, "latitude": 1, "longitude": 1}).sort("recordedAt", 1).limit(2500))
        if not mine:
            return f"I don't have your recorded GPS history for {day:%d %b %Y}, so I can't calculate when you were closest to a friend."
        best = None
        named_friend = next((person for person in context.get("authorizedPeople", [])
                             if person.get("username") not in ("", "you")
                             and re.search(r"\b" + re.escape(str(person.get("username"))) + r"\b", question, re.I)), None)
        if named_friend:
            named_id = str(named_friend.get("id") or "")
            if named_id not in ids or named_id == current_id:
                return "I can't compare against that person's history because it isn't available to you."
            candidate_ids = [named_id]
        else:
            candidate_ids = [friend_id for friend_id in ids if friend_id != current_id]
        for friend_id in candidate_ids:
            friend_points = list(points.find({"userId": _oid(friend_id), "recordedAt": {"$gte": start, "$lt": end}},
                                             {"username": 1, "recordedAt": 1, "latitude": 1, "longitude": 1}).sort("recordedAt", 1).limit(2500))
            stamps = [_as_utc(p["recordedAt"]).timestamp() for p in friend_points]
            for mine_point in mine:
                mine_time = _as_utc(mine_point["recordedAt"])
                index = bisect_left(stamps, mine_time.timestamp())
                for j in (index - 1, index):
                    if j < 0 or j >= len(friend_points):
                        continue
                    friend_point = friend_points[j]
                    friend_time = _as_utc(friend_point["recordedAt"])
                    if abs((friend_time - mine_time).total_seconds()) > 300:
                        continue
                    distance = _distance_m(mine_point["latitude"], mine_point["longitude"], friend_point["latitude"], friend_point["longitude"])
                    if best is None or distance < best["distance"]:
                        best = {"distance": distance, "time": mine_time, "friend": friend_point}
        if best is None:
            return f"I couldn't compare your locations on {day:%d %b %Y}: no saved GPS samples were recorded within 5 minutes of each other."
        local_time = best["time"].astimezone(LOCAL_TZ).strftime("%I:%M:%S %p").lstrip("0")
        name = best["friend"].get("username", "your friend")
        return f"You were closest to {name} at about {local_time} on {day:%d %b %Y}. The nearest contemporaneous GPS samples were {best['distance'] / 1000:.2f} km apart in a straight line; the samples were no more than 5 minutes apart."

    # "Where was I at 1 AM?" and similar explicit clock-time questions.
    location_intent = intent == "location_at_time"
    has_explicit_time = bool(extracted_intent.get("time_text")) or bool(
        re.search(r"(?:at|around|about)s+d{1,2}(?::d{2})?s*(?:a.?m.?|p.?m.?)", question, re.I)
    )
    if not location_intent and not (re.search(r"(?:where|what place|which place)", question, re.I) and has_explicit_time):
        return None
    clock = _requested_clock(question, datetime.now(LOCAL_TZ), extracted_intent)
    if clock is None:
        return None
    subject_id = current_id
    is_self = bool(re.search(r"\b(?:i|me|my)\b", question, re.I)) and not re.search(r"\bmy friend\b", question, re.I)
    if not is_self:
        people = context.get("authorizedPeople", context.get("currentLocations", []))
        person = next((x for x in people
                       if x.get("username") not in ("", "you")
                       and re.search(r"\b" + re.escape(str(x.get("username"))) + r"\b", question, re.I)), None)
        if not person:
            return None
        subject_id = str(person.get("id") or "")
        if subject_id not in ids:
            return "I can't access that person's location history."
    target = _as_utc(clock)
    lower, upper = target - timedelta(minutes=45), target + timedelta(minutes=45)
    samples = list(database["locationpoints"].find(
        {"userId": _oid(subject_id), "recordedAt": {"$gte": lower, "$lte": upper}},
        {"username": 1, "latitude": 1, "longitude": 1, "recordedAt": 1}
    ).sort("recordedAt", 1).limit(500))
    place = None
    visit = database["locationvisits"].find_one(
        {"userId": _oid(subject_id), "startedAt": {"$lte": target}, "lastSeen": {"$gte": target}}, {"placeName": 1})
    if visit:
        place = visit.get("placeName")
    if not place:
        event = database["locationevents"].find_one(
            {"userId": _oid(subject_id), "startAt": {"$lte": target}, "endAt": {"$gte": target}}, {"placeName": 1})
        if event:
            place = event.get("placeName")
    label = "you" if is_self else "your friend"
    requested = clock.strftime("%I:%M %p").lstrip("0")
    if samples:
        point = min(samples, key=lambda p: abs((_as_utc(p["recordedAt"]) - target).total_seconds()))
        recorded = _as_utc(point["recordedAt"])
        delta = abs((recorded - target).total_seconds()) / 60
        recorded_local = recorded.astimezone(LOCAL_TZ).strftime("%I:%M:%S %p").lstrip("0")
        if place:
            return f"At {requested} on {clock:%d %b %Y}, saved visit history indicates {label} was at {place}. The nearest saved GPS point was recorded at {recorded_local} local time ({delta:.0f} minutes from the requested time)."
        return f"The nearest saved GPS point for {label} around {requested} on {clock:%d %b %Y} was {point['latitude']:.5f}, {point['longitude']:.5f}, recorded at {recorded_local} local time ({delta:.0f} minutes away). I don't have a reliable place name for that point."
    if place:
        return f"Saved visit history indicates {label} was at {place} around {requested} on {clock:%d %b %Y}. No nearby raw GPS point was available to verify the exact position."
    return f"I couldn't find a saved GPS point or visit covering {requested} on {clock:%d %b %Y}. This answer requires location history to have been enabled and recorded at that time."


def _oid(value):
    from bson import ObjectId
    return ObjectId(value)
