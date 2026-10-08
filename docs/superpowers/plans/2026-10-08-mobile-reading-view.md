# Mobile Reading View Implementation Plan

> For the restarting session: implement this plan directly with `superpowers:executing-plans`. The user requested self-review, revision, and implementation, with a new branch and incremental commits. They then asked to persist the plan and restart for implementation. Do not restart design approval or ask for an execution-method choice.

**Goal:** Make mobile artifact pages devote almost all their space to the artifact, while making selection-based comments usable on touch browsers.

**Architecture:** Extend the existing Hono-rendered viewer and its vanilla TypeScript client. Add a mobile presentation controller around the existing artifact iframe and comments UI; retain the existing comment API, anchoring, and authenticated message bridge. Capture selection changes inside the frame and explicitly hand a selected quote to a mobile composer.

**Tech stack:** TypeScript, Hono JSX, plain CSS, esbuild, Vitest, Playwright.

**Design source:** The user's screenshot and conversation, summarized below. This is a bounded change to an existing viewer; no separate architectural spec is needed.

## Restart state

- Workspace: `/home/leolobato/artifact-colab`.
- Branch already created and checked out: `feat/mobile-reading-view`.
- Implementation base: `4423547` (`Test that a failed publish returns its claimed uploads`).
- Working tree was clean when the branch was created. Only this plan has been added since.
- No product code, tests, or dependency changes have been made. No tests have run.
- `node_modules` and the usual Playwright cache were not found in the initial directory check. Inspect and install dependencies/browser binaries as needed.
- No repository `AGENTS.md` was found. Check again when restarting in case instructions have changed.
- `.git` is read-only under the workspace sandbox. Creating the branch required an approved escalated `git switch`; staging and committing may also require escalation. Do not work around sandbox restrictions.
- User explicitly requested: “commit as you go, use a new branch,” then “review the plan yourself ... make changes and implement it.” Latest instruction pauses implementation until the restarted session.
- No subagents have been started; use direct implementation unless the user changes that preference.

## Revised design

At viewport widths up to 700 CSS pixels, default to reading view. Render a single compact top bar, about 44 pixels high with usable touch targets, containing the truncated artifact title, **Comments**, and **Full layout**. Hide the site header, full viewer toolbar, and collapsed comment rail. The artifact occupies the available width and remaining dynamic viewport height. Show the selected version in the compact bar when viewing an older version, so hidden toolbar warnings do not make the version ambiguous.

**Full layout** reveals the existing header and toolbar without navigating or reloading the iframe. A **Reading view** control returns to the compact view. Make the revealed toolbar wrap sensibly on narrow screens. Keep this choice in memory for the current page; no new stored preference is necessary. Preserve the existing desktop sidebar preference independently.

On mobile, show comments in a bottom sheet instead of a narrow side column, in either reading or full layout. Reuse the existing threads, filters, replies, attachments, and composer. The sheet has a clear close control and a scrollable body; closing it restores focus and preserves any draft. Treat it as a dialog with appropriate focus containment and background interaction handling. Keep the artifact iframe mounted so scrolling and artifact state survive. On desktop, continue using the existing sidebar.

Do not open the sheet or focus the textarea merely because a touch selection changed: that would interrupt the native selection handles. While a valid selection exists, offer a **Comment on selection** action in a stable mobile location, preferably replacing the top bar's Comments action to avoid an extra overlay over the text or native menu. Tapping it snapshots the anchor and quote before focus moves, opens the sheet, and focuses the composer within that user gesture. Subsequent empty-selection notifications must not discard the committed anchor, hide the composer, or change its quote. Cancel/save clears that committed draft; closing the sheet preserves it.

Use native `selectionchange` events inside the iframe, coalesced to avoid excessive bridge traffic while handles move. Keep mouse selection working. Do not disable the native callout, text selection, scrolling, or zoom. No custom long-press recognizer or document-wide touch interception is needed.

Comparison mode currently takes an early return in the viewer initializer. Initialize shared mobile presentation before that return, label its action **Changes**, and make the existing changes panel reachable as a sheet. Do not offer comment composition in comparison mode. Older versions and users without comment access retain their current read-only rules.

## Findings and code map

| File | Existing behavior and planned responsibility |
| --- | --- |
| `src/server/pages/document.tsx` | Contains viewer CSS and markup, toolbar, iframe, comments aside, and comparison markup. Add compact bar/sheet controls and mobile CSS here. |
| `src/server/pages/layout.tsx` | Shared site header and viewport metadata. Prefer viewer-scoped CSS to hiding navigation throughout the app. Only add a small viewer-specific hook if needed. |
| `src/client/mobileViewer.ts` (new) | Own mobile breakpoint, reading/full toggle, sheet visibility/focus, and viewport/layout notifications. Do not duplicate comment rendering or persistence here. |
| `src/client/viewer.ts` | Owns selection, composer, threads, card alignment, frame scaling, and bridge callbacks. Integrate mobile controls and distinguish live selection from a committed composer draft. |
| `src/client/sidebarCollapse.ts` | Stores desktop sidebar collapse under `artifact-colab:comments-collapsed`. Avoid letting sheet state overwrite this preference; reconcile collapse classes on breakpoint changes. |
| `src/client/compare.ts` | Existing comparison initialization. Read before integrating mobile Changes controls and layout updates. |
| `src/annotator/main.ts` | Runs inside the sandboxed artifact frame. Currently only listens to `mouseup` for selection. Add coalesced selection-change capture. |
| `src/client/bridge.ts`, `src/annotator/protocol.ts` | Existing token-validated selection messages already contain anchor, quoted text, and rectangle. Reuse the protocol unless investigation proves a change necessary. |
| `src/client/frameScale.ts` | Fits overflowing content to available width/height. Reapply when viewer geometry changes without reloading the frame. |
| `e2e/mobile-viewer.spec.ts` (new) | Real viewer regression coverage for mobile layout, selection, composition, dismissal, and breakpoint changes. |
| `playwright.config.ts` | Currently Chromium desktop only. Add a narrowly scoped mobile WebKit project for the new test file, retaining existing Chromium coverage. |

Observed selection path: `onSelection()` in the annotator reads `window.getSelection()` and posts an anchor. `viewer.ts` receives it and immediately calls `showComposer`; a null anchor hides an empty composer and clears its pending anchor. This supports the hypothesis that `mouseup` misses touch selection updates, and also identifies the focus/selection-clearing race that the new mobile flow must avoid. Confirm with a failing browser regression before claiming the cause is fixed.

`alignCards()` positions desktop cards according to their anchor's iframe coordinates, including stubs and clusters. A mobile sheet must render threads in normal flow and clear stale positioning/zone heights, then restore desktop alignment when the breakpoint changes.

## Global constraints

- No new runtime dependencies or comment API/schema changes.
- Preserve the sandboxed frame and capability-token checks.
- Mobile reading view must not alter artifact markup/styles or reload its iframe.
- Fit narrow screens without horizontal overflow in the surrounding app UI.
- Respect comment permissions, current-version checks, and comparison mode.
- Preserve drafts across sheet close/reopen and layout toggles.
- Use `100dvh`, safe-area padding where appropriate, and 16px mobile textarea text to avoid focus zoom. Verify the keyboard does not obscure composer controls; use VisualViewport handling only if needed and cover it.
- Commit independently working stages on `feat/mobile-reading-view`; do not merge, push, or deploy without a separate request.

## Review focus

1. Selection loss between touching the action and opening the composer must not lose the quote or anchor (Task 2).
2. Collapsed desktop preference and crossing the mobile breakpoint must not hide sheet content or leave desktop cards mispositioned (Task 1).
3. Keyboard, short landscape viewports, and long comments must leave Save/Cancel and close controls reachable (Tasks 1–2).
4. Comparison, old versions, and read-only access must not expose an unusable comment action (Tasks 1–2).
5. Opening controls must preserve artifact scroll and JavaScript state, including scaled fixed-width artifacts (Task 1).

## Task 1: Mobile reading layout and comments sheet

**Files:** `src/server/pages/document.tsx`, new `src/client/mobileViewer.ts`, integrations in `src/client/viewer.ts`, `src/client/sidebarCollapse.ts`, `src/client/compare.ts`; new `e2e/mobile-viewer.spec.ts`.

**Controller boundary:** Export `initMobileViewer(onLayoutChange: () => void)` returning a controller with `isMobile(): boolean`, `openPanel(): void`, `closePanel(): void`, and `setSelectionAvailable(available: boolean): void`. The selection action calls back into the existing viewer composer; it must not own anchors or save comments. Choose the smallest callback registration needed after reading initialization order. Initialize shared controls before the comparison early return.

- [x] Inspect the remaining viewer/compare code and test setup; install missing development dependencies and browser binaries. Run baseline `npm run check` and record any pre-existing failures.
- [x] Add browser tests using a real signed-in session and published fixture, following `e2e/frame-scale.spec.ts` setup. At 390×844 assert header/toolbar/rail are hidden, compact controls are visible, artifact width matches the viewport, and its top is within 60 CSS pixels of the page top. Assert Full layout and Reading view toggle without a frame navigation or loss of a marker stored inside the artifact.
- [x] Add panel tests: open/close on mobile, view a real thread, preserve a draft, and switch to desktop and back with desktop collapse preference set. Verify normal-flow card visibility and absence of app horizontal overflow. Exercise mobile Changes in comparison mode and an older version's visible version cue.
- [x] Run the focused Chromium tests and confirm failure is due to missing mobile behavior.
- [x] Implement markup, viewer-scoped responsive CSS, and the mobile controller. Keep modal focus, close behavior, and background interaction consistent. Wire geometry changes to the appropriate scaler/alignment functions; suppress desktop card positioning in the mobile sheet.
- [x] Run the focused tests and inspect mobile screenshots at 390×844 and a short landscape viewport. Check scaled and responsive artifacts. Fix failures before committing.
- [x] Commit the working layout stage as `feat: add mobile artifact reading view and comments sheet`.

## Task 2: Touch selection and explicit comment composition

**Files:** `src/annotator/main.ts`, `src/client/viewer.ts`, `src/client/mobileViewer.ts`, `e2e/mobile-viewer.spec.ts`, `playwright.config.ts`.

**State boundary:** Keep the transient selected anchor/quote separate from the committed composer anchor/quote. Reuse `TextAnchor` and current bridge messages. A selected quote becomes the draft anchor only on explicit mobile comment activation; preserve desktop composition behavior.

- [x] Add a regression that creates a native DOM Range in the real frame without dispatching `mouseup`. Wait for the Comment on selection action; assert the sheet stays closed while changing the selection. Existing `selectPhraseInFrame` dispatches a synthetic mouseup, so do not use it unmodified for this regression.
- [x] Test tapping the action, clearing the frame's native selection, and typing/saving. Assert the composer still displays the final selected quote and the saved thread has that quote; reload and confirm persistence/highlight anchoring. Also test cancel, draft close/reopen, and adjusting the selection before committing it.
- [x] Test that comparison/older/read-only views do not offer composition. Retain coverage of desktop selection and comment saving.
- [x] Run the tests before implementation and confirm the selection-only regression fails for the expected reason.
- [x] Add coalesced `selectionchange` capture in the annotator, preserving selection-length limits and bridge validation. Avoid emitting redundant work for every intermediate handle movement.
- [x] Implement explicit mobile composition and its anchor lifetime. Snapshot before focus changes; ensure click/touch ordering cannot clear the selected anchor before the action runs. Empty selection messages may clear the transient action but must not clear a committed draft. Tapping an existing highlight should open its thread sheet.
- [x] Add a WebKit mobile project scoped to `mobile-viewer.spec.ts` using a Playwright iPhone device. Use project context options in setup rather than accidentally constructing a default desktop context. Run the suite in Chromium and mobile WebKit.
- [x] Commit as `fix: support touch selection and mobile anchored comments`.

## Task 3: Final verification and handoff

- [x] Run `npm run check` (TypeScript and complete Vitest suite).
- [x] Run `npm run build`.
- [x] Run `npm run e2e` for existing Chromium regressions plus the scoped mobile WebKit project. The runner starts a scratch server at port 3789 and uses `test-results/e2e-tmp`; do not point it at production or real development data.
- [x] Inspect screenshots and manually review dialog focus, reachable controls, permissions, breakpoint transitions, selection races, and iframe preservation. Run `git diff --check` and review the complete branch diff.
- [x] Commit any necessary reviewed fixes; update this plan's checkboxes and note test outcomes.
- [x] Report branch, commits, and verification results. Distinguish automated WebKit selection/event coverage from physical iOS native selection-handle and keyboard testing: emulation does not prove all real-device UI behavior. If a real iPhone is unavailable, explicitly list that remaining validation rather than claiming it was tested.

## Resume instruction

Read this plan, check the branch/status, and begin Task 1. Design and implementation are already authorized. The previous session stopped only because the user requested saving the plan for a restart.

## Outcome (2026-10-08)

- `npm run check` 496 unit tests pass; `npm run build` ok; `npm run e2e` Chromium: 57 pass (10 new in `e2e/mobile-viewer.spec.ts`).
- The `mobile-webkit` Playwright project is configured but could **not run** on the dev machine (WebKit host dependencies missing; installing needs sudo). Not yet exercised anywhere.
- Not tested on a physical iOS device: native selection handles, on-screen keyboard behavior (VisualViewport handling in `mobileViewer.ts` is untested), and short landscape viewports.
