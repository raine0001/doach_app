from flask import Blueprint, jsonify, current_app, url_for, send_file, abort
from pathlib import Path

# arcmm_api for process backend to extract arc and shot magic
arcmm_api = Blueprint("arcmm_api", __name__)

def _sessions_root() -> Path:
  # e.g. <project_root>/session
  return Path(current_app.root_path) / "session"

@arcmm_api.get("/api/arcmm/sessions")
def list_sessions():
  root = _sessions_root()
  if not root.exists():
    return jsonify([])

  items = []
  # one level of folders under /session
  for entry in root.iterdir():
    if not entry.is_dir():
      continue
    clips_dir = entry / "clips"
    if not clips_dir.is_dir():
      continue
    # count clips; accept .webm and the occasional .mebm typo
    clips = [p for p in clips_dir.iterdir()
             if p.is_file() and p.suffix.lower() in (".webm", ".mebm", ".mp4")]
    if not clips:
      continue
    mtime = entry.stat().st_mtime
    items.append({
      "id": entry.name,
      "title": entry.name,
      "mtime": mtime,
      "count": len(clips)
    })
  items.sort(key=lambda x: x["mtime"], reverse=True)
  # limit to most recent 50 so we don’t nuke the page
  return jsonify(items[:50])

@arcmm_api.get("/api/arcmm/sessions/<session_id>/shots")
def list_shots(session_id):
  clips_dir = _sessions_root() / session_id / "clips"
  if not clips_dir.is_dir():
    return jsonify([])

  shots = []
  idx = 0
  for p in sorted(clips_dir.iterdir()):
    if not p.is_file() or p.suffix.lower() not in (".webm", ".mebm", ".mp4"):
      continue
    idx += 1
    shots.append({
      "id": f"{session_id}-{idx}",
      "name": p.name,
      "url": url_for("arcmm_api.serve_session_clip",
                     session_id=session_id, filename=p.name)
    })
  return jsonify(shots)

@arcmm_api.get("/api/arcmm/sessions/<session_id>/clip/<path:filename>")
def serve_session_clip(session_id, filename):
  # Serve with the right mimetype even if someone saved as .mebm
  clip_path = _sessions_root() / session_id / "clips" / filename
  if not clip_path.exists() or not clip_path.is_file():
    abort(404)
  suffix = clip_path.suffix.lower()
  if suffix in (".webm", ".mebm"):
    mimetype = "video/webm"
  elif suffix == ".mp4":
    mimetype = "video/mp4"
  else:
    mimetype = None
  return send_file(str(clip_path), mimetype=mimetype, conditional=True)



