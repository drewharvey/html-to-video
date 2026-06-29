# Backlog

Known issues and deferred work for h2v. Add new items at the top with the date noted. When an item is resolved, **don't delete it** — shrink it to a one-line summary (date + commit/PR reference) under the `## Done` section at the bottom.

---

_No open items._

## Done

- **2026-06-29** — Global theme switcher in `h2v review`: header segmented control that sets `data-theme` on every animation iframe at once (themes common to all animations; intersection of declared `h2v-themes`, ≥2 to show), removing it for each animation's default. Lives in `buildReviewHtml`; verified cross-iframe in a real browser.
- **2026-06-26** — VS Code integration / live-reload for `h2v review`: serves the page by default (built-in `http` server + SSE live-reload + file watch), so it auto-reloads in any browser and in VS Code's Simple Browser (⌘/Ctrl-click the printed URL) with no extension; `--no-serve` is the static fallback, `--out` the portable file. Commits `7919353`, `7923718`, `b5fe291`, `489d1c8`.
