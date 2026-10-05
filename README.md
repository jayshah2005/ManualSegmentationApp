# HSI Leaf Curation

Manual curation tool for hyperspectral (HSI) leaf images. The app proposes leaf masks with **NDVI + SAM 2**, then lets you correct seeds, trim borders, and brush-edit before exporting ENVI crops for downstream analysis.

---

## Technologies

| Layer | What we use |
|--------|-------------|
| **UI** | React 19, TypeScript, Vite, Zustand |
| **API** | Python 3.12, FastAPI, Uvicorn, Pydantic |
| **Segmentation** | [SAM 2](https://github.com/facebookresearch/sam2) (Hiera Large) with positive point prompts |
| **Seeds** | NDVI peaks on the Specim cube (`scikit-image` local maxima) |
| **Labels** | EasyOCR on the sticky-note region of the camera PNG |
| **HSI I/O** | `spectral` (ENVI), OpenCV, NumPy, Pillow |
| **Runtime** | [uv](https://docs.astral.sh/uv/) for Python deps; Node 20+ for the frontend; PyTorch (CUDA wheel with CPU fallback) |

Paths (input vines, output folder, SAM2 install) live in [`backend/config.py`](backend/config.py) and can be overridden with environment variables.

---

## Segmentation pipeline

Each sample is one Specim IQ capture folder. Processing order:

```text
Load PNG + reflectance cube
        ↓
OCR sticky note  →  main label + leaf sublabels
        ↓
NDVI seed peaks  →  (or empty if too many — place seeds by hand)
        ↓
SAM 2            →  one mask per seed
        ↓
Sort leaves for UI (left column → right column → sticky-note leaf)
        ↓
You edit: seeds · border shrink · brush add/erase
        ↓
Save             →  ENVI crop + RGB preview per leaf
                     Complete ▶ marks Completed and advances; Save progress marks Incomplete and stays
```

### What each stage does

1. **Load** — Reads the camera PNG (`{id}/{id}.png`) and the reflectance cube (`results/REFLECTANCE_{id}.hdr`). Aligns the cube to the PNG orientation and builds an RGB preview from fixed Specim bands (peak-normalized so sticky notes stay readable). Use the top-bar **Brightness** control if foliage is too dark for brush work — display only; ENVI exports stay raw reflectance.

2. **OCR** — Reads the yellow sticky note for a folder-style main label and numbered leaf labels. You can edit labels in the UI or re-run OCR.

3. **NDVI seeds** — Computes NDVI from NIR/red bands and finds peaks as SAM prompts. If there are more than five automatic peaks, seeds are cleared so you place them manually (avoids noisy over-segmentation).

4. **SAM 2** — Runs one positive point per seed and cleans each mask. Seeds and masks stay linked by **mask index** (seed order). The right-hand rail uses a separate **display index** (spatial sort).

5. **Border** — Shrinks the *original SAM* mask inward (morphological erode). Changing the border never re-trims your brush strokes.

6. **Brush** — Add and erase paint on top of the bordered SAM. Brush paint is the final layer (including reclaiming fringe after a larger border).

7. **Save** — For each leaf: apply border + brush, crop the HSI cube, write ENVI (`.hdr` / `.img`) plus an RGB PNG under  
   `Data/{vineType}/{mainLabel}/{leafLabel}/`.  
   Progress is stored in `Data/progress.json` (`Completed`, `Incomplete`, or `Skipped`).

**Complete ▶** marks the sample Completed and jumps to the next **pending** folder (Pending/Incomplete first; Skipped only when nothing else remains). **Save progress** exports the same crops but marks **Incomplete** and stays on the current sample. **Skip** marks Skipped and advances the same way (pending first, then skipped).

---

## Using the app

### Start

```bash
# From this folder
uv sync          # first time / after dependency changes
./run_dev.sh     # API on :8000, UI on :5173
```

Open **http://127.0.0.1:5173**.

Or run pieces separately:

```bash
./scripts/run_backend.py    # http://127.0.0.1:8000
./scripts/run_frontend.sh   # http://127.0.0.1:5173 (proxies /api)
```

Needs: **uv**, **Node 20+**, and SAM 2 checked out next to this repo (default `../sam2` with checkpoint under `sam2/checkpoints/`).

### Typical curation flow

1. **Choose vine type and sample** in the top bar. Status shows Pending / Incomplete / Completed / Skipped from `progress.json`.

2. **Check the main label** (OCR may have filled it). Fix it if needed; use **Re-OCR** when the sticky note was misread.

3. **Seeds mode** — Green dots are SAM prompts.
   - Click empty leaf area → add a seed (SAM re-runs).
   - Click an existing green dot → remove it.
   - **Reset seeds** restores NDVI auto-seeds (or clears them if auto would over-seed).

4. **Select a leaf** — Use **Select** mode on the canvas, or click a card in the right rail.

5. **Brush mode** — Paint the selected leaf.
   - **Add** / **Remove** in the top bar (or **A** / **D** keys in brush / fullscreen edit).
   - Drag to paint; the on-screen circle matches the stamp.
   - `[` / `]` or the size slider change brush diameter; mouse wheel on the main canvas also nudges size.
   - **Ctrl/Cmd+Z** undo · **Ctrl/Cmd+Shift+Z** redo.

6. **Border** — On a leaf card (or in fullscreen), raise **Border** to peel SAM fringe inward. Brush strokes stay put when you change border.

7. **Full screen / edit** — Zoomed workspace for one leaf:
   - Scroll: zoom **in** toward the cursor, zoom **out** toward center / default view.
   - Pan: Space+drag, Ctrl/Cmd+drag, or middle-click.
   - Same brush / border / undo tools; **Reset** restores the original SAM for that leaf.
   - **Esc** closes and syncs edits. Save is still on the main action bar.

8. **Labels & thumbs** — Edit each leaf label in the rail. Thumbs show the live cutout (border + brush).

9. **Save progress** — Exports crops and marks the sample **Incomplete** (stay here to keep editing). **Complete ▶** marks **Completed** and jumps to the next pending sample (tool resets to **Seeds**). **Skip** advances without export. On refresh / boot, the app opens the first Pending/Incomplete sample; if none are left, it opens a Skipped one. If export folders already exist, you get a confirmation before overwriting.

### Mask appearance

Use the mask color control in the top bar to set overlay tint and opacity (saved in the browser). Preview mode dims non-selected leaves so the active one stands out.

### Tips

- Place **one seed near the center** of each leaf you care about; avoid stems and background.
- If SAM leaks onto background, raise **Border** first, then brush fine detail.
- Prefer brush **erase** for holes and sticky-note bleed; prefer **add** when reclaiming a trimmed edge.
- Undo is per stroke and per leaf; resetting a leaf clears brush ownership for that leaf.

---

## Data layout

**Inputs** (per vine root in `backend/config.py`):

```text
{vineRoot}/{sampleId}/{sampleId}.png
{vineRoot}/{sampleId}/results/REFLECTANCE_{sampleId}.hdr
{vineRoot}/{sampleId}/results/REFLECTANCE_{sampleId}.img
```

**Outputs** (`OUTPUT_BASE_DIR`, default `~/Desktop/CODE/Data`):

```text
Data/progress.json
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.png
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.hdr
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.img
```

Useful env overrides: `HSI_BACO`, `HSI_CHARDONNAY`, `HSI_CAB_FRANC`, `HSI_VIDAL`, `OUTPUT_BASE_DIR`, `SAM2_DIR`, `HSI_HOST`, `HSI_PORT`.

---

## Production (single process)

```bash
cd frontend && npm run build
./scripts/run_backend.py
```

Open **http://127.0.0.1:8000** — the API serves the built UI from `frontend/dist`.

---

## Legacy

[`manual_ndvi_sam_segmentation.py`](manual_ndvi_sam_segmentation.py) is the older Streamlit UI. Prefer this FastAPI + React app for day-to-day curation.
