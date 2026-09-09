# Version Diff (Compare Mode) — Design

**Date:** 2026-09-09
**Status:** Implemented

## Summary

Let a reviewer see what changed between two versions of an artifact. The viewer gets a **Compare** menu that
opens the page in compare mode: the older version on the left, the shown version on the right, with the text
that was removed painted red in the left frame and the text that was added painted green in the right one. The
sidebar lists every change with a few words of context; clicking one scrolls both frames to it, and the
prev/next arrows walk through them.

The diff is over the **rendered text**, not the HTML source: reviewers read the page, not the markup, and
artifact HTML is often a single generated line whose textual diff would be noise. The text compared is the same
normalized text the comment anchoring engine already produces, taken from each frame's live DOM after the
artifact's own scripts have run — so client-rendered content is compared as displayed.

## Decisions

- **Word-level diff of normalized text.** Myers' algorithm (linear-space bisect variant) over whitespace-split
  words, in `src/shared/diff.ts`. Adjacent delete/insert blocks coalesce into one "changed" hunk, and a single
  unchanged word wedged between two large edits is absorbed so a rewritten paragraph reads as one change.
- **Computed in the browser, by the parent page.** Each frame's annotator reports its normalized text
  (`reportText` in the init message, then again whenever the text changes); the parent diffs the two and sends
  each frame the ranges to paint on its side. A server-side diff (linkedom) would miss anything rendered at
  runtime, and the server needs no notion of compare mode beyond validating the URL parameter.
- **Painted with the CSS Custom Highlight API**, exactly like comment highlights: no DOM mutation, so artifact
  scripts keep working. Browsers without the API keep the sidebar list and get the existing banner.
- **URL:** `/d/:slug?version=N&compare=M` — `version` is the "after" side (defaults to current), `compare` the
  "before". An unknown `compare` is a 404 like an unknown `version`; comparing a version with itself is the
  plain view. Toolbar forms (share, watch) round-trip back to the comparison.
- **Commenting is disabled in compare mode**, like when viewing an old version. The sidebar shows changes
  instead of comments; the Open/Resolved/All filter is hidden.
- **Narrow screens** (≤ 900px) drop the "before" pane; removals are still listed in the sidebar.
- **No schema changes, no new dependencies.**

## Known limits

- Formatting-only changes (a color, bold, an image swap) are invisible to a text diff. The empty state says so
  and points at the two panes.
- Text hidden by default in the artifact (closed `<details>`, inactive tabs) is diffed but not visibly painted
  until revealed.
- Frames scroll independently; synchronized scrolling is a possible follow-up using the annotator's position
  stream.

## Pieces

| Where | What |
|---|---|
| `src/shared/diff.ts` | `diffText(oldText, newText)` → hunks as character ranges in each text; context helpers. Unit-tested in `test/shared/diff.test.ts`. |
| `src/annotator/protocol.ts` | `annotator-init.reportText`, parent→frame `diff` (kind + ranges), frame→parent `text` and `diff:click`. `focus`/`scroll` accept hunk ids. |
| `src/annotator/main.ts` | Reports text; maps hunk ranges to DOM ranges; paints `ac-added` / `ac-removed` / `ac-diff-focused`; includes hunks in `positions`, scroll, and click hit-testing. |
| `src/client/bridge.ts` | `reportText` option, `onText`, `onDiffClick`, `sendDiff`; `focusAnchor` / `scrollToAnchor`. |
| `src/client/compare.ts` | Compare mode: two bridges, diff, change list, focus/navigation. Entered from `viewer.ts` when the page data carries `compare`. |
| `src/client/frameScale.ts`, `src/client/sidebarCollapse.ts` | Fit-to-width scaling and the collapsible sidebar, extracted from `viewer.ts` so both modes share them. |
| `src/server/routes/document.tsx` | Parses and validates `?compare=`. |
| `src/server/pages/document.tsx` | Compare menu, two-pane layout, sidebar labels; `viewerUrl()` builds version/compare links. |
