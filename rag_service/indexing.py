"""Location-event serialization and embedding writes."""
from datetime import datetime, timezone
from bson import ObjectId
from config import EMBEDDING_MODEL, RAG_DISABLE_EMBEDDINGS
from database import collection
from embeddings import embeddings

def event_text(event: dict[str, Any]) -> str:
    return (
        f"Person: {event.get('username', 'unknown')}. Event: {event.get('eventType', 'unknown')}. "
        f"Place: {event.get('placeName', 'unknown')}. Summary: {event.get('summary', '')}. "
        f"Started: {event.get('startAt', '')}. Ended: {event.get('endAt', '')}. "
        f"Duration minutes: {event.get('durationMinutes', 0)}."
    )

def index_event(event_id: str) -> bool:
    if RAG_DISABLE_EMBEDDINGS or embeddings_unavailable():
        print("[Reva RAG] embedding writes disabled by RAG_DISABLE_EMBEDDINGS; skipping event indexing", flush=True)
        return False
    if not ObjectId.is_valid(event_id):
        raise ValueError("Invalid eventId")
    event = collection().find_one({"_id": ObjectId(event_id)})
    if not event:
        return False
    print(f"[Reva RAG] indexing event {event_id}: embedding started", flush=True)
    vector = embeddings().embed_query(event_text(event))
    print(f"[Reva RAG] indexing event {event_id}: embedding completed; MongoDB update starting", flush=True)
    collection().update_one(
        {"_id": event["_id"]},
        {"$set": {"embedding": vector, "embeddingModel": EMBEDDING_MODEL, "embeddingUpdatedAt": datetime.now(timezone.utc)}},
    )
    print(f"[Reva RAG] indexing event {event_id}: completed", flush=True)
    return True

