# HSI Leaf Curation

Manual curation tool for hyperspectral (HSI) leaf captures. The app proposes leaf masks with **NDVI + SAM 2**, then lets you fix seeds, trim borders, brush-edit, and label leaves before exporting ENVI crops.

Stack: **FastAPI + React** (this app). An older Streamlit script still lives in the repo for reference only.

---

## Prerequisites

| Tool | Why |
|------|-----|
| **[uv](https://docs.astral.sh/uv/)** | Python deps + virtualenv |
| **Node.js 20+** and npm | Frontend (Vite) |
| **Git** | Clone this repo and SAM 2 |
| **GPU (optional)** | CUDA PyTorch is faster; CPU works but SAM is slow |

You also need:

1. Access to your Specim IQ sample folders (per vine type).
2. A writable output directory for exports + `progress.json`.

---

## One-time setup

Do this from the **repository root** (`Segmentation/`).

### 1. Clone SAM 2 into this repo

SAM 2 lives under **`third_party/sam2`** (gitignored — each machine clones its own copy).

Do **not** put the checkout at `./sam2` in the repo root: that folder name shadows the `sam2` Python package when you run the app from this directory.

```bash
mkdir -p third_party
git clone https://github.com/facebookresearch/sam2.git third_party/sam2
```

If you already have a checkout elsewhere:

```bash
mkdir -p third_party
mv /path/to/sam2 third_party/sam2
# or: ln -s /path/to/sam2 third_party/sam2
```

### 2. Download the SAM 2.1 Large checkpoint

Default config expects:

```text
third_party/sam2/checkpoints/sam2.1_hiera_large.pt
```

```bash
cd third_party/sam2/checkpoints
./download_ckpts.sh          # downloads several sizes; Large is required
cd ../../..
```

Confirm the file exists:

```bash
ls -lh third_party/sam2/checkpoints/sam2.1_hiera_large.pt
```

### 3. Point the app at your data

Edit path defaults in [`backend/config.py`](backend/config.py), **or** set environment variables (preferred on shared machines):

| Variable | Purpose |
|----------|---------|
| `HSI_BACO` | Root folder of Baco samples |
| `HSI_CHARDONNAY` | Root folder of Chardonnay samples |
| `HSI_CAB_FRANC` | Root folder of Cab Franc samples |
| `HSI_VIDAL` | Root folder of Vidal samples |
| `OUTPUT_BASE_DIR` | Where exports + `progress.json` are written |
| `SAM2_DIR` | Override if SAM 2 is not at `third_party/sam2` |

Each vine root must contain Specim folders like:

```text
{vineRoot}/{sampleId}/{sampleId}.png
{vineRoot}/{sampleId}/results/REFLECTANCE_{sampleId}.hdr
{vineRoot}/{sampleId}/results/REFLECTANCE_{sampleId}.img
```

### 4. Install dependencies

```bash
uv sync
cd frontend && npm install && cd ..
```

`uv sync` installs Python packages and links the local `third_party/sam2` package (editable). CUDA extension build for SAM is **off** by default (`SAM2_BUILD_CUDA=0`) so install works without a matching `nvcc`.

---

## Run the app (dev)

```bash
./run_dev.sh
```

- UI: **http://127.0.0.1:5173**
- API: **http://127.0.0.1:8000** (Vite proxies `/api`)

Or separately:

```bash
./scripts/run_backend.py
./scripts/run_frontend.sh
```

First sample load warms **SAM 2** and **EasyOCR** — expect a pause once per process.

---

## First-time walkthrough

1. Open the UI and pick a **vine type** + **sample**. Status comes from `OUTPUT_BASE_DIR/progress.json` (`Pending` / `Incomplete` / `Completed` / `Skipped`).
2. Check the **main label** (OCR may have filled it). Fix it or use **Re-OCR**.
3. **Seeds** (green dots) — one prompt per leaf you care about.
   - Click empty leaf → add seed (SAM re-runs).
   - Click a green dot → remove it.
   - **Reset seeds** restores NDVI auto-seeds (or clears them if auto would over-seed).
4. **Select** a leaf on the canvas or in the right rail.
5. **Brush** — **Add (A)** / **Remove (D)**; drag to paint. `[` / `]` or the size slider change diameter. **Ctrl/Cmd+Z** undo.
6. **Border** on the leaf card (or fullscreen) peels SAM fringe inward; brush strokes stay put.
7. **Full screen / edit** for zoomed work. **Esc** closes and syncs. Save stays on the main action bar.
8. Set each **leaf label** in the rail (shows on the main image).
9. **Save progress** — export crops, mark **Incomplete**, stay on this sample.  
   **Complete ▶** — export, mark **Completed**, advance to the next pending sample.  
   **Skip** — no export; advance.  
   If export folders already exist, you get a confirmation before overwrite.

### Tips

- Place one seed near the **center** of each leaf; avoid stems and background.
- Prefer raising **Border** before fine brush work when SAM leaks onto background.
- **Brightness** in the top bar is display-only (helps dark foliage); ENVI exports stay raw reflectance.
- Mask tint / opacity live in the top bar (saved in the browser).

---

## How the pipeline works

```text
Load PNG + reflectance cube
        ↓
OCR sticky note  →  main label + leaf sublabels
        ↓
NDVI seed peaks  →  (or empty if too many — place seeds by hand)
        ↓
SAM 2            →  one mask per seed
        ↓
Sort leaves for UI (left → right → sticky-note leaf)
        ↓
You edit: seeds · border shrink · brush add/erase · labels
        ↓
Save             →  ENVI crop + RGB preview per leaf
```

| Stage | What it does |
|-------|----------------|
| **Load** | Camera PNG + reflectance cube; RGB preview from fixed Specim bands |
| **OCR** | Sticky-note text → main / leaf labels (editable) |
| **NDVI seeds** | Peaks as SAM prompts; if more than five, seeds clear for manual placement |
| **SAM 2** | One positive point per seed; cleaned masks |
| **Border** | Erodes the *original SAM* only; never re-trims brush paint |
| **Brush** | Add/erase on top of bordered SAM (final layer) |
| **Save** | Crop cube per leaf → `Data/{vine}/{mainLabel}/{leafLabel}/` |

**Indexing:** seeds/masks use **mask index** (seed order). The right rail uses **display index** (spatial sort).

---

## Outputs

Default `OUTPUT_BASE_DIR` is set in `backend/config.py` (override with env):

```text
Data/progress.json
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.png
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.hdr
Data/{vineType}/{mainLabel}/{leafLabel}/{leafLabel}.img
```

Queue on boot / after Complete or Skip: first **Pending/Incomplete** across vines, then **Skipped** if nothing else remains.

---

## Production (single process)

```bash
cd frontend && npm run build && cd ..
./scripts/run_backend.py
```

Open **http://127.0.0.1:8000** — the API serves `frontend/dist`.

Useful runtime env: `HSI_HOST`, `HSI_PORT`, `SAM2_BUILD_CUDA=1` (only if you intentionally build the CUDA extension).

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `ModuleNotFoundError: sam2` / uv sync fails on SAM-2 | `third_party/sam2` exists and is a full SAM 2 clone; then `uv sync` again |
| RuntimeError about running from parent of sam2 repo | Checkout must be `third_party/sam2`, not a top-level `./sam2` folder |
| SAM fails / missing checkpoint | `third_party/sam2/checkpoints/sam2.1_hiera_large.pt` present |
| No samples in the dropdown | Vine roots in `backend/config.py` / `HSI_*` env vars point at real folders |
| Blank or wrong RGB | Sample has both `{id}.png` and `results/REFLECTANCE_{id}.hdr` |
| Very slow first load | Normal — SAM + EasyOCR warm up once per process |
| CUDA / nvcc build errors during install | Keep `SAM2_BUILD_CUDA=0` (default in `run_dev.sh`) |

---

## Repo layout

```text
Segmentation/
  backend/           FastAPI app, pipeline, config
  frontend/          React UI
  third_party/sam2/  Local SAM 2 clone (gitignored) + checkpoints
  scripts/           Backend / frontend helpers
  run_dev.sh         Start API + Vite together
  manual_ndvi_sam_segmentation.py   Legacy Streamlit UI
```

---

## Legacy

[`manual_ndvi_sam_segmentation.py`](manual_ndvi_sam_segmentation.py) is the older Streamlit UI. Prefer this FastAPI + React app for day-to-day curation.
