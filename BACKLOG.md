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

## VS Code integration for `h2v review` mode

**Noted:** 2026-06-25

Make `h2v review` viewable inside VS Code without switching to a browser, ideally with hot reload on edits. Scoped in discussion; not built.

**Phase 1 — prototype "VS Code Integration" (do this first).** Design specifically around viewing the review *inside VS Code*, **even if it requires an installed extension** (e.g. Microsoft's Live Preview). This is the biggest-win case and the one worth proving: Claude running in the VS Code terminal while the review previews in a VS Code pane, no window switch. Don't generalize yet — just make this one workflow genuinely good (render + hot reload on edit). Only after it's proven do we consider Phase 2.

**Phase 2 — abstract / generalize (only if Phase 1 lands).** Consider making it more generic or multi-tier: a self-contained, no-extension path (`--serve [--watch]` = a tiny Node `http` server + SSE live-reload, works in the built-in Simple Browser), and/or other surfaces. Keep the static `file://` behavior the default; any server/watch stays opt-in so `review` doesn't grow a networking surface (port handling, firewall prompt, bind-address choice) in the common case.

**Findings so far:**

- `h2v review` is currently static: it writes a self-contained HTML file and opens the OS browser via `file://`; no server, no watch. The process only stays alive to clean up the tmpfile on Ctrl-C.
- VS Code preview surfaces (the built-in Simple Browser, and the Live Preview extension) serve over HTTP and won't load `file://` iframe sub-resources, so the current tmpfile won't render in them. `--out` produces an inline/self-contained page that *does* render, but it's frozen (no hot reload).
- Most promising Phase-1 path: a **`--link`** mode that writes the review page into the workspace with relative iframe `src`s so the Live Preview extension serves and hot-reloads it. Before relying on it, verify Live Preview reloads on a referenced *sub-resource* change (an edited animation file inside an iframe), not just the top-level file.
