"""Vision pipeline stages (no HTTP here — routers call these).

Typical sample lifecycle
------------------------
1. ``load``     — PNG (OCR) + ENVI cube → HSI-derived RGB for SAM/canvas
2. ``ocr``      — yellow sticky note → main folder label + leaf sublabels
3. ``seeds``    — NDVI peaks as SAM positive prompts (or [] → user clicks)
4. ``sam``      — one mask per seed; centroids sorted for UI display order
5. ``masks``    — border erosion helpers (export + Suggest borders)
6. ``save``     — cropped ENVI/PNG under OUTPUT_BASE_DIR + progress.json

Brush edits happen in the browser; the API receives PNG masks and stores them
in ``Session.edited_masks`` before save.
"""
