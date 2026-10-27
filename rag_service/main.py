"""Reva RAG service entry point.

Keep this module intentionally small: configuration, HTTP wiring, and shutdown.
"""
import os
import threading
from http.server import ThreadingHTTPServer

from config import RAG_DISABLE_EMBEDDINGS
from database import mongo
from api import RevaRAGHandler
from embeddings import warm_embeddings_in_background


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    # Render injects PORT at runtime. Locally use 8001 because the shared .env
    # may contain the Node application's PORT.
    is_render = any(
        os.getenv(key)
        for key in ("RENDER", "RENDER_SERVICE_ID", "RENDER_EXTERNAL_URL")
    )
    port = int(os.getenv("PORT") or "8001") if is_render else 8001
    server = ThreadingHTTPServer((host, port), RevaRAGHandler)
    print(f"Reva RAG service listening on {host}:{port}", flush=True)
    if not RAG_DISABLE_EMBEDDINGS:
        threading.Thread(
            target=warm_embeddings_in_background,
            name="reva-embedding-warmup",
            daemon=True,
        ).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if mongo is not None:
            mongo.close()


if __name__ == "__main__":
    main()
