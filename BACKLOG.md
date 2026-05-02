# Backlog

Known issues and deferred work for h2v. Add new items at the top with the date noted; remove or move to a commit/PR reference when resolved.

---

## Theme switching does not work in `h2v review` mode

**Noted:** 2026-05-02

In the review page, each animation is embedded as `<iframe srcdoc="…">`. The animation's in-page theme switcher (the circle swatches we added in `ee0e565`) is visible — `data-h2v-hide` is intentionally not applied during review per `CLAUDE.md`'s invariant — but clicking a swatch doesn't change the rendered theme inside the iframe.

**Likely culprits to investigate:**

- `srcdoc` iframes have an opaque origin, so `sessionStorage` may throw or be inaccessible. The `try/catch` swallows the failure silently, but only the persistence half should be affected; click handlers and `setAttribute('data-theme', …)` should still work.
- Worth confirming with browser devtools: open a review page, click a swatch, check whether `<html data-theme="…">` actually gets set on the iframe's document and whether the `[data-theme="…"]` CSS rules are applying. If the attribute is set but styles don't recalc, the issue is elsewhere (CSS-injection ordering, etc.).

**Fix likely lives in:** the demo animations' switcher JS, or `buildReviewHtml`'s iframe construction. Not yet diagnosed.
