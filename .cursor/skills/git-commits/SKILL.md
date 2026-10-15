---
name: git-commits
description: commit/branch message convention — always follow when committing, staging, or creating branches
alwaysApply: true
---

# Git commit & branch

Only commit / push / create branches when the user explicitly asks. Never commit proactively.

## Message format

`type[/scope[/subscope]][+scope]: summary`

- **Types (only these):** `feat` · `fix` · `refactor` · `chore`
  - No `style` or `docs` type — visual polish is `refactor`; documentation is `chore/docs`
- **Scope** — from the allowlist below. Omit only for genuinely extension-wide changes.
- **Never invent a new scope** — if none fit, ask the user before adding one.
- **Nested subscope** with `/` (`engine/workday`); **combined scopes** with `+` when one commit truly spans two (`feat/sidepanel+auth: …`)
- **Summary** — lowercase first word, imperative, no trailing period, ≤ ~50 chars (hard ~60)
- Single-line subject by default; body only when the *why* isn’t obvious (blank line before body; `git commit -F` preferred)

### Scope allowlist

| Scope | Use for |
|-------|---------|
| `preview` | Right column |
| `edit` | full screen edit mode |
| `header` | header in the full screen mode |
| `docs` | README, store listing copy, publisher/setup docs (`chore/docs`) |
| `backend` | Other backend related changes |
| `engine` | Image Extraction engine |
| `tests` | Jest / test files |
| `agents` | `.cursor/agents`, `.cursor/skills`, `.cursor/rules` |
| `gitignore` | `.gitignore` |
| `settings` | Persisted settings and the settings modal |
| `loader` | Image/cube loaders and folder discovery |
| `setup` | First-run wizard, GPU check, SAM install |
| `canvas` | Segmentation canvas and prompt tools |
| `launcher` | `start.sh` / `start.bat` and run scripts |
| `fs` | Server-side folder browser |

Need a new scope? Ask first, then add it here.

### Examples

```
feat: create initial app
fix/edit: esc always exits fullscreen
chore/header: change brightness input to a range slider
feat/preview: sync leaf rail thumbnails with view exposure
fix/backend: prefer pending sample across vines on boot
refactor/engine/workday: simplify crop bounds lookup
chore/docs: document save progress vs complete flow
feat/sidepanel+auth: gate panel on session token
```

**Branches (same type/scope as primary commit):**

```
fix/edit-esc-fullscreen
feat/preview-rail-brightness
chore/docs-readme-save-flow
```

## Branches

`type/scope[-short-slug]` — same type/scope as the primary commit. Prefer over ad-hoc `cursor/…` unless the user requires that prefix.

## Atomic commits

One coherent change per commit. Split unrelated concerns; stage precise paths (`git add <paths>`), not blind `git add .`.

## Safety

No history rewrite / force-push / `--no-verify` / discarding unfamiliar files unless explicitly asked. Never commit secrets (`.env*`, client secrets). Don’t push unless asked. Don’t update git config.
