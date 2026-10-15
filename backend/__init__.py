"""Segmentation Tool backend (FastAPI).

Mental model
------------
One operator segments one image at a time. The process holds a single in-memory
``Session`` (see ``backend.session``). HTTP routes in ``backend.api`` mutate that
session; vision work lives in ``backend.pipeline``.

Objects are addressed by a stable ``id``. User choices (folders, model, export)
live in ``backend.settings`` and are persisted per user, not in env vars.
"""
