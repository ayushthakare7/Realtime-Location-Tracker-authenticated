"""Authorized location-history retrieval and evidence preparation."""
from datetime import datetime, timedelta, timezone
from typing import Any
from bson import ObjectId

from config import DB_NAME, RAG_DISABLE_EMBEDDINGS, TOP_K, VECTOR_INDEX
from database import collection, mongo
from embeddings import embeddings, embeddings_unavailable
from intent import GraphState
from location_tools import resolve_location_tools

def location_tools_node(state: GraphState) -> GraphState:
    """Route relevant questions to free public geocoding tools.

    Inputs are supplied by the Node API after authorization. Public providers
    label coordinates or resolve public place names; they never establish a
    person's live location or replace MongoDB GPS/history.
    """
    try:
        result = resolve_location_tools(
            state.get("question", ""),
            state.get("context", {}),
            mongo[DB_NAME]["geocodingcache"] if mongo is not None else None,
        )
        if result.get("route") != "none":
            print(f"[Reva RAG] location tool route={result.get('route')} results={len(result.get('results', []))}", flush=True)
        return {"location_tools": result}
    except Exception as exc:
        print(f"[Reva RAG] location tools unavailable ({type(exc).__name__}); continuing with authorized context", flush=True)
        return {"location_tools": {"route": "error", "results": []}}

def retrieve_node(state: GraphState) -> GraphState:
    """Retrieve authorized history semantically first, with a MongoDB fallback.

    The fallback is important during first deployment, while Atlas builds the
    vector index, or if embedding/vector search temporarily fails.
    """
    ids = [ObjectId(value) for value in state["authorized_user_ids"] if ObjectId.is_valid(value)]
    if not ids:
        return {"events": []}

    q = state["question"].lower()
    now = datetime.now(timezone.utc)
    date_filter: dict[str, Any] = {}
    if "yesterday" in q:
        end = datetime(now.year, now.month, now.day)
        date_filter = {"$gte": end - timedelta(days=1), "$lt": end}
    elif "today" in q or "tonight" in q:
        start = datetime(now.year, now.month, now.day)
        date_filter = {"$gte": start, "$lte": now}
    elif "this week" in q:
        start = datetime(now.year, now.month, now.day) - timedelta(days=now.weekday())
        date_filter = {"$gte": start, "$lte": now}

    base_query: dict[str, Any] = {"userId": {"$in": ids}}
    if date_filter:
        base_query["recordedAt"] = date_filter

    fields = {
        "userId": 1, "username": 1, "eventType": 1, "placeName": 1,
        "summary": 1, "startAt": 1, "endAt": 1, "durationMinutes": 1,
        "recordedAt": 1,
    }

    def serialize(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for event in events:
            event["_id"] = str(event.get("_id", ""))
            event["userId"] = str(event.get("userId", ""))
            for key in ("startAt", "endAt", "recordedAt"):
                if event.get(key):
                    event[key] = event[key].isoformat()
        return events

    # Semantic retrieval is optional: on constrained hosts, bypass model loading
    # and use the authorized MongoDB query instead of hanging on first download.
    if RAG_DISABLE_EMBEDDINGS or embeddings_unavailable():
        reason = "disabled by configuration" if RAG_DISABLE_EMBEDDINGS else "startup warmup failed"
        print(f"[Reva RAG] embeddings unavailable ({reason}); using MongoDB history fallback", flush=True)
    else:
        try:
            print("[Reva RAG] retrieve: embedding query started", flush=True)
            query_vector = embeddings().embed_query(state["question"])
            print("[Reva RAG] retrieve: embedding query completed; vector search starting", flush=True)
            vector_filter: dict[str, Any] = {"userId": {"$in": ids}}
            if date_filter:
                vector_filter["recordedAt"] = date_filter
            pipeline = [
                {"$vectorSearch": {
                    "index": VECTOR_INDEX, "path": "embedding",
                    "queryVector": query_vector,
                    "numCandidates": max(100, TOP_K * 20),
                    "limit": TOP_K, "filter": vector_filter,
                }},
                {"$project": {
                    **fields,
                    "score": {"$meta": "vectorSearchScore"},
                }},
            ]
            events = list(collection().aggregate(pipeline))
            print(f"[Reva RAG] retrieve: vector search completed with {len(events)} events", flush=True)
            if events:
                print(f"[Reva RAG] semantic retrieval returned {len(events)} events", flush=True)
                return {"events": serialize(events)}
            print("[Reva RAG] vector search returned no events; using MongoDB fallback", flush=True)
        except Exception as exc:
            print(f"[Reva RAG] semantic retrieval unavailable ({type(exc).__name__}: {exc}); using MongoDB fallback", flush=True)

    # Reliable non-vector fallback: query only authorized users and sort by time.
    # Include enough events to answer multi-place/stay-duration questions.
    print("[Reva RAG] retrieve: MongoDB fallback query starting", flush=True)
    events = list(
        collection().find(base_query, fields)
        .sort([("startAt", -1)])
        .limit(min(max(TOP_K, 6), 8))
    )
    print(f"[Reva RAG] MongoDB fallback returned {len(events)} events", flush=True)
    return {"events": serialize(events)}

def evidence_node(state: GraphState) -> GraphState:
    events = state.get("events", [])
    if not events:
        return {"evidence": "No matching historical location events were retrieved."}
    lines = []
    # Bound each record so even verbose user-generated summaries cannot overflow
    # Groq's request token budget when several events are retrieved.
    for e in events[:8]:
        username = str(e.get("username") or "unknown")[:60]
        event_type = str(e.get("eventType") or "unknown")[:40]
        place = str(e.get("placeName") or "unknown")[:100]
        summary = str(e.get("summary") or "")[:160]
        start = str(e.get("startAt") or "")[:40]
        end = str(e.get("endAt") or "")[:40]
        duration = str(e.get("durationMinutes") or 0)[:12]
        lines.append(
            f"Person={username}; event={event_type}; place={place}; "
            f"start={start}; end={end}; duration_minutes={duration}; summary={summary}"
        )
    return {"evidence": "\n".join(lines)}

