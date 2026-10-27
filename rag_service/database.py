"""MongoDB lifecycle and collection/index access."""
from pymongo import MongoClient
from config import DB_NAME, MONGO_URI, VECTOR_INDEX

mongo = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000) if MONGO_URI else None

def collection():
    if mongo is None:
        raise RuntimeError("MONGO_URI is missing")
    return mongo[DB_NAME]["locationevents"]

def ensure_vector_index() -> str:
    coll = collection()
    try:
        indexes = coll.database.command({"listSearchIndexes": coll.name}).get("cursor", {}).get("firstBatch", [])
    except Exception:
        indexes = []
    existing = next((item for item in indexes if item.get("name") == VECTOR_INDEX), None)
    if existing:
        return "existing"
    coll.database.command({
        "createSearchIndexes": coll.name,
        "indexes": [{
            "name": VECTOR_INDEX,
            "type": "vectorSearch",
            "definition": {
                "fields": [
                    {"type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine"},
                    {"type": "filter", "path": "userId"},
                    {"type": "filter", "path": "recordedAt"}
                ]
            }
        }]
    })
    return "created"

