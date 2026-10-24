import os
import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime, timedelta
from typing import Any, TypedDict

from bson import ObjectId
from dotenv import load_dotenv
from pymongo import MongoClient
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph

load_dotenv()

TOKEN = os.getenv("RAG_SERVICE_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
VECTOR_INDEX = os.getenv("RAG_VECTOR_INDEX", "location_event_vector_index_384")
TOP_K = int(os.getenv("RAG_TOP_K", "10"))
DB_NAME = os.getenv("MONGO_DB_NAME", "location_tracker")
if MONGO_URI and not os.getenv("MONGO_DB_NAME"):
    try:
        from urllib.parse import urlparse
        DB_NAME = urlparse(MONGO_URI).path.lstrip("/").split("/")[0] or DB_NAME
    except Exception:
        pass

mongo = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000) if MONGO_URI else None
_embeddings = None
_llm = None

class GraphState(TypedDict, total=False):
    question: str
    authorized_user_ids: list[str]
    context: dict[str, Any]
    intent: str
    events: list[dict[str, Any]]
    evidence: str
    answer: str

def collection():
    if mongo is None:
        raise RuntimeError("MONGO_URI is missing")
    return mongo[DB_NAME]["locationevents"]

def embeddings():
    global _embeddings
    if _embeddings is None:
        _embeddings = HuggingFaceEmbeddings(
            model_name=EMBEDDING_MODEL,
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )
    return _embeddings

def llm():
    global _llm
    if _llm is None:
        if not GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is missing")
        _llm = ChatGroq(model=GROQ_MODEL, groq_api_key=GROQ_API_KEY, temperature=0)
    return _llm

def event_text(event: dict[str, Any]) -> str:
    return (
        f"Person: {event.get('username', 'unknown')}. Event: {event.get('eventType', 'unknown')}. "
        f"Place: {event.get('placeName', 'unknown')}. Summary: {event.get('summary', '')}. "
        f"Started: {event.get('startAt', '')}. Ended: {event.get('endAt', '')}. "
        f"Duration minutes: {event.get('durationMinutes', 0)}."
    )

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

def index_event(event_id: str) -> bool:
    if not ObjectId.is_valid(event_id):
        raise ValueError("Invalid eventId")
    event = collection().find_one({"_id": ObjectId(event_id)})
    if not event:
        return False
    vector = embeddings().embed_query(event_text(event))
    collection().update_one(
        {"_id": event["_id"]},
        {"$set": {"embedding": vector, "embeddingModel": EMBEDDING_MODEL, "embeddingUpdatedAt": datetime.utcnow()}},
    )
    return True

def classify_node(state: GraphState) -> GraphState:
    # Classification is advisory only. Do not let a transient Groq/model issue
    # prevent retrieval of location history.
    question = state["question"].lower()
    if any(term in question for term in ("summarize", "summary", "most visited", "usual", "frequently")):
        return {"intent": "summary"}
    if any(term in question for term in ("right now", "currently", "current location", "where is")):
        return {"intent": "shared_presence"}
    if any(term in question for term in ("yesterday", "today", "last week", "this week", "visited", "visit", "where did", "how long", "when did", "history", "spent")):
        return {"intent": "history"}
    return {"intent": "other"}

def retrieve_node(state: GraphState) -> GraphState:
    """Retrieve authorized history semantically first, with a MongoDB fallback.

    The fallback is important during first deployment, while Atlas builds the
    vector index, or if embedding/vector search temporarily fails.
    """
    ids = [ObjectId(value) for value in state["authorized_user_ids"] if ObjectId.is_valid(value)]
    if not ids:
        return {"events": []}

    q = state["question"].lower()
    now = datetime.utcnow()
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

    # Semantic retrieval is the primary path. It may fail if Atlas vector search
    # is not configured yet, or the vector index is still being built.
    try:
        query_vector = embeddings().embed_query(state["question"])
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
        if events:
            print(f"[Reva RAG] semantic retrieval returned {len(events)} events", flush=True)
            return {"events": serialize(events)}
        print("[Reva RAG] vector search returned no events; using MongoDB fallback", flush=True)
    except Exception as exc:
        print(f"[Reva RAG] semantic retrieval unavailable ({type(exc).__name__}: {exc}); using MongoDB fallback", flush=True)

    # Reliable non-vector fallback: query only authorized users and sort by time.
    # Include enough events to answer multi-place/stay-duration questions.
    events = list(
        collection().find(base_query, fields)
        .sort([("startAt", -1)])
        .limit(max(100, TOP_K * 10))
    )
    print(f"[Reva RAG] MongoDB fallback returned {len(events)} events", flush=True)
    return {"events": serialize(events)}

def evidence_node(state: GraphState) -> GraphState:
    events = state.get("events", [])
    if not events:
        return {"evidence": "No matching historical location events were retrieved."}
    lines = []
    for e in events:
        lines.append(
            f"Person={e.get('username')}; event={e.get('eventType')}; place={e.get('placeName')}; "
            f"start={e.get('startAt')}; end={e.get('endAt')}; duration_minutes={e.get('durationMinutes')}; "
            f"summary={e.get('summary')}; relevance={e.get('score')}"
        )
    return {"evidence": "\n".join(lines)}

def generate_node(state: GraphState) -> GraphState:
    context = state.get("context", {})
    safe_context = {
        "currentLocations": context.get("currentLocations", []),
        "calculatedDistances": context.get("calculatedDistances", []),
    }
    response = llm().invoke([
        SystemMessage(content=(
            "You are Reva, a privacy-aware location assistant. Answer only from the authorized current context "
            "and retrieved historical evidence. Never invent people, places, times, durations, distances, routes, "
            "or events. Treat backend calculations as authoritative. If evidence is insufficient, say so clearly."
        )),
        HumanMessage(content=f"Question: {state['question']}\nAuthorized current context: {safe_context}\nRetrieved history:\n{state.get('evidence', '')}"),
    ])
    return {"answer": str(response.content).strip()}

def build_graph():
    graph = StateGraph(GraphState)
    graph.add_node("classify_intent", classify_node)
    graph.add_node("retrieve_authorized_events", retrieve_node)
    graph.add_node("prepare_evidence", evidence_node)
    graph.add_node("generate_answer", generate_node)
    graph.add_edge(START, "classify_intent")
    graph.add_edge("classify_intent", "retrieve_authorized_events")
    graph.add_edge("retrieve_authorized_events", "prepare_evidence")
    graph.add_edge("prepare_evidence", "generate_answer")
    graph.add_edge("generate_answer", END)
    return graph.compile()

workflow = build_graph()

class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def check_token(authorization: str | None):
    if not TOKEN or not authorization or not hmac.compare_digest(authorization, "Bearer " + TOKEN):
        raise RequestError(401, "Unauthorized")


class RevaRAGHandler(BaseHTTPRequestHandler):
    server_version = "RevaRAG/1.0"

    def send_json(self, status: int, payload: dict[str, Any]):
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path == "/":
            self.send_json(200, {
                "success": True,
                "service": "reva-rag",
                "message": "Reva Python RAG service is running. Use /health for diagnostics; POST /ask is the authenticated question endpoint.",
                "health": "/health",
                "ask": "POST /ask",
                "framework": "Python standard library HTTP server (no FastAPI)",
            })
            return
        if path == "/health":
            configured = bool(TOKEN and MONGO_URI and GROQ_API_KEY)
            mongo_ok = False
            mongo_error = None
            try:
                if mongo is None:
                    raise RuntimeError("MONGO_URI is missing")
                mongo.admin.command("ping")
                mongo_ok = True
            except Exception as exc:
                mongo_error = type(exc).__name__
            healthy = configured and mongo_ok
            self.send_json(200 if healthy else 503, {
                "success": healthy,
                "service": "reva-rag",
                "configured": configured,
                "mongoConnected": mongo_ok,
                "mongoError": mongo_error,
                "vectorIndex": VECTOR_INDEX,
                "embeddingModel": EMBEDDING_MODEL,
                "answerModelConfigured": bool(GROQ_API_KEY),
            })
            return
        self.send_json(404, {"success": False, "detail": "Not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        print(f"[Reva RAG] POST {path} received; checking authorization", flush=True)
        try:
            check_token(self.headers.get("Authorization"))
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1_000_000:
                raise RequestError(400, "Invalid request body size")
            try:
                payload = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise RequestError(400, "Request body must be valid JSON")

            if path == "/index-event":
                event_id = payload.get("eventId")
                if not isinstance(event_id, str) or not event_id:
                    raise RequestError(400, "eventId is required")
                try:
                    result = {"success": True, "indexed": index_event(event_id)}
                except Exception as exc:
                    print(f"[Reva RAG] indexing failed: {type(exc).__name__}: {exc}", flush=True)
                    raise RequestError(502, "Could not index location event") from exc
                self.send_json(200, result)
                return

            if path == "/reindex":
                try:
                    index_status = ensure_vector_index()
                    cursor = collection().find(
                        {"eventType": {"$in": ["arrival", "stay", "departure"]}},
                        {"_id": 1, "embedding": 1},
                    )
                    total = 0
                    for row in cursor:
                        if index_event(str(row["_id"])):
                            total += 1
                    result = {"success": True, "vectorIndex": index_status, "indexedEvents": total}
                except Exception as exc:
                    print(f"[Reva RAG] reindex failed: {type(exc).__name__}: {exc}", flush=True)
                    raise RequestError(502, "Could not reindex location events") from exc
                self.send_json(200, result)
                return

            if path == "/ask":
                print("[Reva RAG] /ask payload validated; starting RAG workflow", flush=True)
                question = payload.get("question")
                user_ids = payload.get("authorizedUserIds")
                context = payload.get("context", {})
                if not isinstance(question, str) or not question.strip() or len(question) > 500:
                    raise RequestError(400, "question must be a non-empty string of at most 500 characters")
                if not isinstance(user_ids, list) or len(user_ids) > 100:
                    raise RequestError(400, "authorizedUserIds must contain at most 100 IDs")
                if not all(isinstance(value, str) for value in user_ids):
                    raise RequestError(400, "authorizedUserIds must contain strings")
                if not isinstance(context, dict):
                    raise RequestError(400, "context must be an object")
                try:
                    print("[Reva RAG] /ask invoking LangGraph workflow", flush=True)
                    result = workflow.invoke({
                        "question": question.strip(),
                        "authorized_user_ids": user_ids,
                        "context": context,
                    })
                    print("[Reva RAG] /ask workflow completed; sending response", flush=True)
                    response = {
                        "success": True,
                        "answer": result.get("answer", ""),
                        "intent": result.get("intent", "other"),
                        "retrievedEvents": len(result.get("events", [])),
                    }
                except Exception as exc:
                    print(f"[Reva RAG] request failed: {type(exc).__name__}: {exc}", flush=True)
                    raise RequestError(502, "RAG processing failed. Check service logs and configuration.") from exc
                self.send_json(200, response)
                return

            self.send_json(404, {"success": False, "detail": "Not found"})
        except RequestError as exc:
            self.send_json(exc.status, {"success": False, "detail": str(exc)})
        except Exception as exc:
            print(f"[Reva RAG] HTTP handler failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"success": False, "detail": "Internal server error"})

    def log_message(self, fmt: str, *args):
        print(f"[Reva RAG] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT") or "8001")
    server = ThreadingHTTPServer((host, port), RevaRAGHandler)
    print(f"Reva RAG service listening on {host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if mongo is not None:
            mongo.close()
