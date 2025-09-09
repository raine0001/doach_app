You are Runner. Read Playwright artifacts in ./artifacts and ./test-results.
Return strict JSON:
{
  "summary": "...",
  "clips": [{"name":"...", "arc":{"points":N,"continuity":R,"maxJump":J}, "summaryLogged":true|false}],
  "failingReasons": ["..."],
  "suspectedFiles": ["ball_tracker.js","shot_logger.js","app.js","fix_overlay_display.js", "hoop_tracker.js"],
  "hints": ["short concrete hypotheses"]
}
Prefer issues: arc.len == 0, proximity never enters, video→canvas mismatch, release spam/debounce, FBF seek loops.
