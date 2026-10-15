"""Vision pipeline stages (no HTTP here — routers call these).

Typical image lifecycle
-----------------------
1. ``discover``  — find images/cubes under the input folder (deduped, recursive)
2. ``loaders``   — read any supported format as ``(H, W, B)``
3. ``display``   — band choice + stretch + orientation → 8-bit RGB for SAM/canvas
4. ``sam``       — points/box prompts → one mask per object
5. ``masks``     — border erosion helpers (export + Suggest borders)
6. ``export``    — cut-outs, masks, metadata under the output folder
7. ``progress``  — Completed / Incomplete / Skipped per image
"""
