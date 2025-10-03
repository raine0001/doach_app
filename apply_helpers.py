from pathlib import Path
path = Path('static/js/app.js')
text = path.read_text(encoding='utf-8', errors='replace')
marker = 'window.snapshotAtRelease'
idx = text.find(marker)
if idx == -1:
    raise SystemExit('snapshotAtRelease not found')
end = text.find('// ---------- Release emitter', idx)
if end == -1:
    raise SystemExit('release emitter marker not found')
helper = '''function summarizePoseSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const keys = ['stanceWidthFeet','stanceWidth','stanceRatio','elbowExtDeg','armVerticalityDeg','torsoLeanAngle','kneeFlex','feetAngleDiff','headToHoopDeg','followThroughHoldFrames'];
  const out = {};
  for (const key of keys) {
    const val = snap[key];
    if (typeof val === 'number') out[key] = Number(val.toFixed(1));
  }
  return out;
}

function clonePoseSnapshotLocal(snap) {
  if (!snap || typeof snap !== 'object') return null;
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(snap)
      : JSON.parse(JSON.stringify(snap));
  } catch {
    try { return JSON.parse(JSON.stringify(snap)); }
    catch { return null; }
  }
}

function poseHasMetricsLocal(snap) {
  if (!snap || typeof snap !== 'object') return false;
  return Object.values(snap).some(v => typeof v === 'number' && Number.isFinite(v));
}

function ensurePoseReleaseMap() {
  if (!window.__POSE_RELEASES || typeof window.__POSE_RELEASES.set !== 'function') {
    try { window.__POSE_RELEASES = new Map(); }
    catch { window.__POSE_RELEASES = new Map(); }
  }
  return window.__POSE_RELEASES;
}

function storeReleaseSnapshot(shotId, snap) {
  if (!poseHasMetricsLocal(snap)) return;
  const map = ensurePoseReleaseMap();
  try { map.set(shotId, clonePoseSnapshotLocal(snap) || snap); }
  catch { map.set(shotId, snap); }
}

function setPoseIfMissing(shotId, snap) {
  if (!poseHasMetricsLocal(snap)) return;
  try {
    const map = window.__shots;
    if (!map?.get?.(shotId)?.poseSnapshot) {
      const cloned = clonePoseSnapshotLocal(snap) || snap;
      window.updateShot?.(shotId, { poseSnapshot: cloned });
    }
  } catch {}
  storeReleaseSnapshot(shotId, snap);
}

'''
text = text[:end] + helper + text[end:]
path.write_text(text, encoding='utf-8')

