"""HSI leaf curation backend (FastAPI).

Mental model
--------------------------
One operator curates one sample at a time. The process holds a single in-memory
``Session`` (see ``backend.session``). HTTP routes in ``backend.api`` mutate that
session; heavy vision work lives in ``backend.pipeline`` (load → OCR → NDVI seeds
→ SAM2 → border shrink → ENVI save).

Key index distinction (used everywhere):
- ``maskIndex`` — position in ``sam_masks`` / ``edited_masks`` (seed order).
- ``displayIndex`` — UI leaf order from ``sorted_centroids`` (left column, right
  column, then sticky-note region). Labels and shrinks are keyed by displayIndex.

Frontend talks to ``/api/...``; Vite proxies to uvicorn in dev. Paths and model
locations are in ``backend.config`` (override with env vars).
"""