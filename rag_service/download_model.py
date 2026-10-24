"""Download and smoke-test the embedding model during the Render build.

Run after installing requirements:
    python download_model.py

The model cache is baked into the service image, so the first live request
does not need to download model files.
"""
import os

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv(
    "EMBEDDING_MODEL",
    "sentence-transformers/all-MiniLM-L6-v2",
)

print(f"[Reva RAG build] Downloading/loading embedding model: {MODEL_NAME}", flush=True)
model = SentenceTransformer(MODEL_NAME, device="cpu")
vector = model.encode(
    ["Reva embedding model deployment smoke test"],
    normalize_embeddings=True,
    convert_to_numpy=True,
)
if vector.ndim != 2 or vector.shape[0] != 1 or vector.shape[1] != 384:
    raise RuntimeError(f"Unexpected embedding shape: {getattr(vector, 'shape', None)}")
print(f"[Reva RAG build] Model ready; embedding dimension={vector.shape[1]}", flush=True)
