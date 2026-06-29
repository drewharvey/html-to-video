# Backlog

Known issues and deferred work for h2v. Add new items at the top with the date noted. When an item is resolved, **don't delete it** — shrink it to a one-line summary (date + commit/PR reference) under the `## Done` section at the bottom.

---

## Global theme switcher in `h2v review` mode

**Noted:** 2026-06-25

Add a single control on the review page that switches the theme for *all* embedded animations at once — scoped to the themes that exist across **every** animation in the workspace. Today each card has only its own per-iframe switcher; there's no way to flip the whole page to e.g. "light" in one action.

**Design notes / open questions:**

- Compute the common theme set = the intersection of each animation's declared `h2v-themes` across all discovered animations (`buildReviewAnimations` already parses per-animation themes). Only offer global themes present in *every* animation, so no animation is asked to render a theme it doesn't declare.
- The global control drives each iframe the same way the per-card switcher does (sets `data-theme` on the iframe document's `<html>`), fanning out to all iframes. Decide how it composes with subsequent per-card overrides (global sets all; a card can still diverge afterward).
- Lives in `buildReviewHtml` (the global control markup + the fan-out JS). Only render the control when the common set is non-empty.

## Done

- **2026-06-26** — VS Code integration / live-reload for `h2v review`: serves the page by default (built-in `http` server + SSE live-reload + file watch), so it auto-reloads in any browser and in VS Code's Simple Browser (⌘/Ctrl-click the printed URL) with no extension; `--no-serve` is the static fallback, `--out` the portable file. Commits `7919353`, `7923718`, `b5fe291`, `489d1c8`.
