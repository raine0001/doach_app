# Shot Flow Acceptance Criteria (v2)

This checklist defines what “pass” means for a shot cycle and what the E2E agent must verify. It mirrors the current system flow and runtime contracts.

## Preflight (one‑time)
- `app.js`, `ball_tracker.js`, `shot_logger.js` loaded
- `tools/overlay_clean_mode.js` loaded (clean last‑pass drawer)
- Optional: `tools/arc_contract.js` loaded (arc metrics + auto‑tune)
- `setOverlayMode('clean')` called for production/e2e view (debug only on demand)

## Clip readiness
- Video fired `loadedmetadata`/`canplay`
- Overlay canvas sized to video: `overlay.width === video.videoWidth`, `overlay.height === video.videoHeight`
- Helper calls: `ensureOverlayCss()`, `lockOverlayToVideo()`

## Hoop lock (deterministic)
- Primary: user/test click → `attachHoop({cx,cy,w,h})` → `__hoopConfirmed=true`
- Fallback: program lock via `attachHoop`
- Verified via `getLockedHoopBox()` returning `{ cx, cy, w, h }` in canvas space

## Analyzer cadence
- `analyzeVideoFrameByFrame(video, overlay)` running
- RVFC preferred; frame‑pump active (nudges `currentTime += 1/__videoFPS` when paused)
- Invariants:
  - `window.__analyzerActive === true`
  - `window.lastDetectedFrame.__frameIdx` increments monotonically

## Per‑frame tick (simplified order)
1. Pixels → detect (YOLO) + pose
2. `stabilizeLockedHoop(objects)` → canvas hoop
3. `updatePlayerTracker(pose)`
4. Ball: `updateBall({x,y}, frame)`
   - small gap‑fill (≤3 frames)
   - step clamp/interp (≤ 40 px per frame)
5. Debug overlays (suppressed by clean mode)
6. `tickReadiness(...)`
7. Signal: `dispatchEvent('analyzer:frame-done')`

## Release gating
- `isPoseInReleasePosition(playerState)` + corridor latches once
- On latch:
  - `markRelease(frame)`
  - `__readyForScoring = true`
  - `dispatchEvent('shot:release', { frame, via })`

## Proximity/shot FSM
- While tracking:
  - `proxEnterFrame` stamped when inside rect
  - `proxExitFrame` on first leave
  - `_postExitFrames` increments after exit
- End conditions (any):
  - `_postExitFrames ≥ POST_EXIT_HOLD` (6–8), or
  - `ball.y > rimBottom + FINALIZE_BELOW_MARGIN` (8–10), or
  - video ended backup

## Finalize & summary
- `finalizeShotIfPending(tag)` builds summary and sets:
  - `window.__lastSummary = summary`
  - `shotLog.push(summary)`
  - `ballState.frozenShots.push({ trail: frozenTrailCopy })`
- Events: `shot:summary`, `shot:end`
- If `arc_contract.js` present:
  - `summary.arcMetrics` computed
  - `summary.arcPass` + `arcReasons` set
  - Optional auto‑tune via `proposeAutoFix()/applyFixes()`

## Rendering (clean last‑pass)
- Clean overlay draws only:
  - Smoothed arc (Catmull–Rom) for live window (release→exit) or last frozen trail
  - Hoop ring
- Clean overlay freeze contract:
  - After `shot:summary` → `__overlayFreeze = true` → no more clears/redraws
  - On `shot:release` → `__overlayFreeze = false`
- Debug drawers swallowed while `__overlayMode === 'clean'`

## Acceptance checks (E2E)
Must pass for each cycle:

Logical
- `__lastSummary` exists for the attempt
- Proximity enter/exit stamped or finalization occurred via `ended`
- If arc contract loaded: thresholds hold (tune per clip):
  - `points ≥ 12`, `continuity ≥ 0.92`, `maxJump ≤ 40`, `R² ≥ 0.90`

Visual
- Arc rendered: overlay has ≥ N painted pixels after summary (default N=700 for ring arc at 3px stroke)
- Arc frozen: overlay pixel hash unchanged for ~400 ms after summary
- Optionally assert rings: `__overlayArcDrawnCount ≥ 10`

Instrumentation available
- `__overlayArcDrawnCount` (rings drawn last pass)
- `__overlayLastTrailMode` ('live' | 'frozen')
- `__overlayLastTrailInput` (source trail points)
- `__overlayMode` ('clean' | 'debug')
- `__overlayFreeze` (bool)

## Fail‑fast conditions
- No `__lastSummary` before video ends
- Arc not rendered (painted pixel count below threshold)
- Arc not frozen (hash differs after stability window)
- Ring count below minimum (if asserted)
- Arc metrics (when available) fail tolerance

## Playwright helpers (snippets)

- Ensure frames advance and analyzer latches:
```ts
await page.evaluate(() => (window as any).analyzeVideoFrameByFrame?.(v,c));
await page.waitForFunction(() => (window as any).__analyzerActive === true, { timeout: 2000 }).catch(() => {});
// robust starter covers autoplay + manual stepping
await startFrames(page);
```

- Assert arc rendered and frozen:
```ts
await assertArcRenderedAndFrozen(page, { minPixels: 700, stableMs: 400 });
```

- Hard lock hoop (CI‑safe):
```ts
await hardForceHoopLock(page, { x: 1216, y: 244, baseW: 1280, baseH: 720 });
```

## Notes
- Clean overlay draws nothing pre‑release to avoid pre‑shot noise
- Frozen arc remains visible until next release
- You can toggle modes at runtime via `setOverlayMode('clean'|'debug')`

