# Backlog

Known issues and deferred work for h2v. Add new items at the top with the date noted; remove or move to a commit/PR reference when resolved.

---

## Global theme switcher in `h2v review` mode

**Noted:** 2026-06-25

Add a single control on the review page that switches the theme for *all* embedded animations at once — scoped to the themes that exist across **every** animation in the workspace. Today each card has only its own per-iframe switcher; there's no way to flip the whole page to e.g. "light" in one action.

**Design notes / open questions:**

- Compute the common theme set = the intersection of each animation's declared `h2v-themes` across all discovered animations (`buildReviewAnimations` already parses per-animation themes). Only offer global themes present in *every* animation, so no animation is asked to render a theme it doesn't declare.
- The global control drives each iframe the same way the per-card switcher does (sets `data-theme` on the iframe document's `<html>`), fanning out to all iframes. Decide how it composes with subsequent per-card overrides (global sets all; a card can still diverge afterward).
- Lives in `buildReviewHtml` (the global control markup + the fan-out JS). Only render the control when the common set is non-empty.

## VS Code integration / live-reload for `h2v review` mode — RESOLVED

**Noted:** 2026-06-25 · **Resolved:** 2026-06-26 (branch `vscode-review-integration`)

Goal: view the review inside VS Code without switching to a browser, with hot reload on edits.

**Phase 1** (confirmed working) prototyped this as `--vscode` + the Live Preview extension. **Phase 2 superseded it:** `h2v review` now **serves the page itself by default** (tiny built-in Node `http` server + SSE live-reload + file watch) — so live reload works with no extension, in any browser *and* in VS Code's built-in Simple Browser, and the plain-browser flow also gains auto-reload (no more manual ⌘R). The Phase-1 `--vscode` flag was removed as redundant. `--no-serve` keeps the old static `file://` page (also the auto-fallback if the port can't bind); `--out` is the portable self-contained file; `--port`/`--host`/`--lan` tune the server. Covered by `tests/test-review-serve.js`.

**Remaining:** hands-on confirmation on macOS that SSE reload works inside the Simple Browser webview (verified headlessly via curl + the integration test; user to confirm the in-VS-Code experience).
