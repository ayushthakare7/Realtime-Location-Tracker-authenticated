"""HTTP boundary: authentication, validation, health, and RAG endpoints."""
import hmac
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse
from typing import Any
from config import TOKEN, MONGO_URI, GROQ_API_KEY, GROQ_MODEL, EMBEDDING_MODEL, VECTOR_INDEX, RAG_DISABLE_EMBEDDINGS, DB_NAME
from database import mongo, collection, ensure_vector_index
from embeddings import embeddings, _embedding_warmup_state
from indexing import index_event
from intent import extract_question_intent
from graph import workflow
from time_queries import answer_time_question

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
            with _embedding_warmup_state_lock:
                warmup_state = dict(_embedding_warmup_state)
            self.send_json(200 if healthy else 503, {
                "success": healthy,
                "service": "reva-rag",
                "configured": configured,
                "mongoConnected": mongo_ok,
                "mongoError": mongo_error,
                "vectorIndex": VECTOR_INDEX,
                "embeddingModel": EMBEDDING_MODEL,
                "embeddingsReady": warmup_state["complete"],
                "embeddingWarmupOk": warmup_state["ok"],
                "embeddingWarmupError": warmup_state["error"],
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
                        "locationTools": result.get("location_tools", {"route": "none", "results": []}),
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

