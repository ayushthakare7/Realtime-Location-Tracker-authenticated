import os
import hmac
import threading
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict

from bson import ObjectId
from dotenv import load_dotenv
from pymongo import MongoClient
from langchain_core.messages import HumanMessage, SystemMessage
from fastembed import TextEmbedding
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph
from time_queries import answer_time_question

load_dotenv()

TOKEN = os.getenv("RAG_SERVICE_TOKEN", "")
MONGO_URI = os.getenv("MONGO_URI", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
_configured_embedding_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2").strip()
# FastEmbed accepts canonical model IDs, not the underlying Xenova ONNX repository ID.
EMBEDDING_MODEL = (
    "sentence-transformers/all-MiniLM-L6-v2"
    if _configured_embedding_model.lower() in {
        "xenova/all-minilm-l6-v2",
        "xenova/all-minilm-l6-v2-quantized",
        "qdrant/all-minilm-l6-v2-onnx",
    }
    else _configured_embedding_model
)
VECTOR_INDEX = os.getenv("RAG_VECTOR_INDEX", "location_event_vector_index_384")
# Set RAG_DISABLE_EMBEDDINGS=true on small hosted instances to avoid model-download stalls.
# Retrieval then uses the authorized MongoDB history fallback and skips embedding writes.
RAG_DISABLE_EMBEDDINGS = os.getenv("RAG_DISABLE_EMBEDDINGS", "false").strip().lower() in {"1", "true", "yes", "on"}
TOP_K = max(1, min(int(os.getenv("RAG_TOP_K", "6")), 8))
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
_embeddings_lock = threading.Lock()
_llm_lock = threading.Lock()

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

class FastEmbedAdapter:
    """Small ONNX-based embedding adapter with the interface used by Reva."""
    def __init__(self, model_name: str):
        self.model = TextEmbedding(model_name=model_name)

    def embed_query(self, text: str) -> list[float]:
        return next(self.model.query_embed(text)).tolist()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [vector.tolist() for vector in self.model.passage_embed(texts)]


def embeddings():
    global _embeddings
    if _embeddings is None:
        with _embeddings_lock:
            if _embeddings is None:
                print(f"[Reva RAG] ONNX embedding model initialization started: {EMBEDDING_MODEL}", flush=True)
                try:
                    _embeddings = FastEmbedAdapter(EMBEDDING_MODEL)
                    # Force one inference during startup of the first request so
                    # model/runtime errors are reported before vector search.
                    test_vector = _embeddings.embed_query("Reva embedding smoke test")
                    if len(test_vector) != 384:
                        raise RuntimeError(f"Expected 384-dimensional embeddings, got {len(test_vector)}")
                    print("[Reva RAG] ONNX embedding model initialization completed; dimension=384", flush=True)
                except Exception as exc:
                    print(f"[Reva RAG] ONNX embedding model initialization failed: {type(exc).__name__}: {exc}", flush=True)
                    raise
    return _embeddings

def llm():
    global _llm
    if _llm is None:
        with _llm_lock:
            if _llm is None:
                if not GROQ_API_KEY:
                    raise RuntimeError("GROQ_API_KEY is missing")
                print(f"[Reva RAG] Groq client initialization started: {GROQ_MODEL}", flush=True)
                _llm = ChatGroq(model=GROQ_MODEL, groq_api_key=GROQ_API_KEY, temperature=0)
                print("[Reva RAG] Groq client initialization completed", flush=True)
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
    if RAG_DISABLE_EMBEDDINGS:
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

def extract_question_intent(question: str) -> dict[str, Any]:
    """Use the configured LLM to map natural language to a small, validated query plan."""
    prompt = (
        "Extract the user's intent from a question to a personal location-history assistant. "
        "Return ONLY one JSON object with keys intent, subject, date_text, time_text, start_time_text, "
        "end_time_text, place, second_place, comparison, and needs_history. "
        "Allowed intent values: location_at_time, closest_people, visit_duration, movement_between_places, "
        "location_timeline, history_summary, current_presence, other. "
        "subject is self, a friend name if explicitly named, or unknown. "
        "Use short natural-language values copied/normalized from the question; do not invent missing dates or times. "
        "For 'last night around one' use date_text='last night', time_text='1 AM'. "
        "For 'when was my friend closest to me today' use intent='closest_people', date_text='today', "
        "subject='friend' unless a name is given, comparison='minimum_distance'. "
        "For 'where was I at 1am' use intent='location_at_time', subject='self', time_text='1 AM'. "
        "needs_history must be true for questions that require saved location records. "
        "Do not answer the question; only extract its meaning.\nQuestion: " + question
    )
    try:
        response = llm().invoke([
            SystemMessage(content="You are a strict intent and slot extractor. Output valid JSON only."),
            HumanMessage(content=prompt),
        ])
        raw = str(response.content).strip()
        raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        parsed = json.loads(raw)
        allowed = {"location_at_time", "closest_people", "visit_duration", "movement_between_places",
                   "location_timeline", "history_summary", "current_presence", "other"}
        if not isinstance(parsed, dict) or parsed.get("intent") not in allowed:
            return {"intent": "other"}
        keys = ("subject", "date_text", "time_text", "start_time_text", "end_time_text",
                "place", "second_place", "comparison")
        result = {"intent": parsed["intent"], "needs_history": bool(parsed.get("needs_history", True))}
        for key in keys:
            value = parsed.get(key)
            result[key] = value.strip()[:100] if isinstance(value, str) else ""
        return result
    except Exception as exc:
        print(f"[Reva RAG] intent extraction unavailable ({type(exc).__name__}); using fallback intent rules", flush=True)
        return {"intent": "other"}


def classify_node(state: GraphState) -> GraphState:
    # Prefer the validated LLM-extracted intent, then fall back to keyword rules.
    extracted_intent = state.get("intent")
    allowed_intents = {
        "location_at_time", "closest_people", "visit_duration", "movement_between_places",
        "location_timeline", "history_summary", "current_presence", "other"
    }
    if extracted_intent in allowed_intents:
        return {"intent": extracted_intent}
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
    if RAG_DISABLE_EMBEDDINGS:
        print("[Reva RAG] embeddings disabled; using MongoDB history fallback", flush=True)
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

def generate_node(state: GraphState) -> GraphState:
    context = state.get("context", {})
    safe_context = {
        "currentLocations": context.get("currentLocations", []),
        "calculatedDistances": context.get("calculatedDistances", []),
    }
    print("[Reva RAG] generate: Groq invocation starting", flush=True)
    response = llm().invoke([
        SystemMessage(content=(
            "You are Reva, a privacy-aware location assistant. Answer only from the authorized current context "
            "and retrieved historical evidence. Never invent people, places, times, durations, distances, routes, "
            "or events. Treat backend calculations as authoritative. If evidence is insufficient, say so clearly."
        )),
        HumanMessage(content=f"Question: {state['question']}\nAuthorized current context: {safe_context}\nRetrieved history:\n{state.get('evidence', '')}"),
    ])
    print("[Reva RAG] generate: Groq invocation completed", flush=True)
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

    def do_HEAD(self):
        # Render and other health probes may issue HEAD requests.
        # Respond without a body; the regular GET /health endpoint remains authoritative.
        path = urlparse(self.path).path.rstrip("/") or "/"
        self.send_response(200 if path in {"/", "/health"} else 404)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

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
                    # Extract meaning and time/place slots from natural language first. The LLM
                    # plans the query; deterministic MongoDB calculations answer from actual records.
                    extracted_intent = extract_question_intent(question.strip())
                    direct_answer = answer_time_question(
                        question.strip(), user_ids, context, mongo[DB_NAME], extracted_intent
                    )
                    if direct_answer is not None:
                        self.send_json(200, {
                            "success": True,
                            "answer": direct_answer,
                            "intent": extracted_intent.get("intent", "time_query"),
                            "extractedIntent": extracted_intent,
                            "retrievedEvents": 0,
                        })
                        return
                    print("[Reva RAG] /ask invoking LangGraph workflow", flush=True)
                    result = workflow.invoke({
                        "question": question.strip(),
                        "authorized_user_ids": user_ids,
                        "context": context,
                        "intent": extracted_intent.get("intent", "other"),
                    })
                    print("[Reva RAG] /ask workflow completed; sending response", flush=True)
                    response = {
                        "success": True,
                        "answer": result.get("answer", ""),
                        "intent": result.get("intent", extracted_intent.get("intent", "other")),
                        "extractedIntent": extracted_intent,
                        "retrievedEvents": len(result.get("events", [])),
                    }
                except Exception as exc:
                    print(f"[Reva RAG] request failed: {type(exc).__name__}: {exc}", flush=True)
                    raise RequestError(502, "RAG processing failed. Check service logs and configuration.") from exc
                self.send_json(200, response)
                return

            self.send_json(404, {"success": False, "detail": "Not found"})
        except RequestError as exc:
            print(f"[Reva RAG] request rejected with HTTP {exc.status}: {exc}", flush=True)
            self.send_json(exc.status, {"success": False, "detail": str(exc)})
        except Exception as exc:
            print(f"[Reva RAG] HTTP handler failed: {type(exc).__name__}: {exc}", flush=True)
            self.send_json(500, {"success": False, "detail": "Internal server error"})

    def log_message(self, fmt: str, *args):
        print(f"[Reva RAG] {self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    # Render injects PORT at runtime. Locally, ignore PORT from the shared
    # project .env (often used by the Node server) and keep the RAG service on 8001.
    is_render = any(os.getenv(key) for key in ("RENDER", "RENDER_SERVICE_ID", "RENDER_EXTERNAL_URL"))
    port = int(os.getenv("PORT") or "8001") if is_render else 8001
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
