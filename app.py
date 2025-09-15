# Unified DOACH app.py — optimized for dual model use, cleaned init, and removed /detect_video_init

from flask import Flask, request, Response, jsonify, send_from_directory, send_file, session
from flask_cors import CORS
from werkzeug.utils import secure_filename
import numpy as np
import requests
import cv2
import os
try:
    import torch  # type: ignore
    from ultralytics.nn.tasks import DetectionModel  # type: ignore
    from ultralytics import YOLO  # type: ignore
    TORCH_AVAILABLE = True
except Exception:
    TORCH_AVAILABLE = False
import base64
from openai import OpenAI
from dotenv import load_dotenv
from werkzeug.security import generate_password_hash, check_password_hash
import traceback
import re
import csv
import shutil
import subprocess
import json 
import glob
import time
from pathlib import Path
import io
import wave
from datetime import datetime
import threading
try:
    from sqlalchemy import create_engine, Column, Integer, String, DateTime, Float, Boolean, Text, ForeignKey
    from sqlalchemy.types import JSON as MyJSON
    from sqlalchemy.orm import declarative_base, sessionmaker, relationship
    SQLA_AVAILABLE = True
except Exception:
    SQLA_AVAILABLE = False

try:
    if TORCH_AVAILABLE:
        torch.serialization.add_safe_globals([DetectionModel])
except Exception:
    pass

# Make CV/Torch single-threaded on Windows (prevents deadlocks / resets)
cv2.setNumThreads(0)
os.environ.setdefault("OMP_NUM_THREADS", "1")
try:
    if TORCH_AVAILABLE:
        torch.set_num_threads(1)
except Exception:
    pass

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app, resources={r"/api/*": {"origins": "*"}})
# Secret key for session cookies (load from .env if present)
try:
    load_dotenv()
    app.secret_key = os.getenv('SECRET_KEY') or os.urandom(24)
except Exception:
    app.secret_key = os.urandom(24)

# Simple trace flag (enable with DOACH_TRACE=1)
try:
    _TRACE = os.getenv('DOACH_TRACE', '1')
    TRACE_ON = not (_TRACE.lower() in ('0', 'false', 'no', 'off', ''))
except Exception:
    TRACE_ON = True

def _trace(*args, **kwargs):
    try:
        if TRACE_ON:
            print(*args, **kwargs)
    except Exception:
        pass

REQUIRED_LABELS = {'basketball', 'hoop', 'net', 'backboard', 'player'}
CONFIDENCE_THRESHOLD = 0.01  # Lowered from 0.75 to 0.01 for improved detection
SKIPPED_LOG_PATH = 'skipped_frames.json'
UPLOAD_FOLDER = 'uploads'
FRAME_FOLDER = 'frame_cache'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(FRAME_FOLDER, exist_ok=True)

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
PRESET_FILE = DATA_DIR / "voice_presets.json"

# Track active users (lightweight, in-memory). Production should use Redis.
app.active_users = {}
app.observer_frames = {}

@app.before_request
def _track_active_user():
    try:
        uid = session.get('user_id')
        if uid:
            app.active_users[uid] = {
                'user_id': uid,
                'last_seen': datetime.utcnow().isoformat(timespec='seconds') + 'Z',
                'path': request.path,
                'ip': request.headers.get('X-Forwarded-For') or request.remote_addr,
            }
            # prune very old ( > 2h )
            if len(app.active_users) > 500:
                to_del = []
                for k, v in app.active_users.items():
                    try:
                        dt = datetime.fromisoformat(v['last_seen'].rstrip('Z'))
                        if (datetime.utcnow() - dt).total_seconds() > 7200:
                            to_del.append(k)
                    except Exception:
                        to_del.append(k)
                for k in to_del:
                    app.active_users.pop(k, None)
    except Exception:
        pass

client = None

def get_openai_client():
    global client

    if client is not None:
        return client

    load_dotenv()  # Ensure .env is loaded

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("❌ OPENAI_API_KEY not set in environment or .env file.")

    client = OpenAI(api_key=api_key)
    return client

LABEL_TO_CLASS = {
    'basketball': 0,
    'hoop': 1,
    'net': 2,
    'backboard': 3,
    'player': 4
}

# --- Shared paths used by ONNX export + training monitor ---
BASE_DIR = Path(__file__).resolve().parent  # (you already set this later; ok to keep here)

RUNS_DETECT_DIR   = os.path.join(app.root_path, 'runs', 'detect')
STATIC_DIR        = os.path.join(app.root_path, 'static')
STATIC_MODELS_DIR = os.path.join(STATIC_DIR, 'models')
STATIC_CONFIG_DIR = os.path.join(STATIC_DIR, 'config')
DETECTOR_CFG_PATH = os.path.join(STATIC_CONFIG_DIR, 'detector.json')

os.makedirs(STATIC_MODELS_DIR, exist_ok=True)
os.makedirs(STATIC_CONFIG_DIR, exist_ok=True)

# 🧠 In-memory state
frame_memory = {'ball_path': [], 'frame_id': 0}

#load object mapping
LABELS_PATH = os.path.join(app.root_path, 'static', 'models', 'labels.json')
try:
    with open(LABELS_PATH, 'r', encoding='utf-8') as _f:
        _LABELS = json.load(_f)
    CANON_NAMES = _LABELS.get('classes', [])
except Exception:
    CANON_NAMES = ['basketball','hoop','net','backboard','player']  # fallback


# --- Canonical class names (must be defined BEFORE model_det is created) ---
LABELS_PATH = os.path.join(app.root_path, 'static', 'models', 'labels.json')

def _load_canon_names():
    try:
        with open(LABELS_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # support either {"classes":[...]} or {"names":[...]}
        names = data.get('classes') or data.get('names') or []
        if not names:
            raise ValueError("labels.json has no classes/names")
        return names
    except Exception:
        # safe fallback to your basketball profile
        return ['basketball', 'hoop', 'net', 'backboard', 'player']

CANON_NAMES = _load_canon_names()

# 🔄 Load both models
BASE_DIR = Path(__file__).resolve().parent
model_det = None
TRAINING_NAMES = None
predict_lock = threading.Lock()
if TORCH_AVAILABLE:
    try:
        model_det = YOLO(BASE_DIR / "weights/best.pt")
        TRAINING_NAMES = getattr(getattr(model_det, 'model', None), 'names', None)
        print('[detector] training names:', TRAINING_NAMES)
        print("✅ Model loaded")
    except Exception as e:
        print('⚠️ YOLO model load failed:', e)
else:
    print('⚠️ Torch/Ultralytics not available. Server will run with local ONNX (front-end) only.')



#----------- video routes -----------
UPLOAD_DIR = os.path.join(app.root_path, 'static', 'videos')
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTS = {'.mp4', '.mov', '.webm', '.mkv'}

def _is_video(fname):
    return os.path.splitext(fname)[1].lower() in ALLOWED_EXTS

@app.get('/videos')
def list_videos():
    items = []
    for fname in sorted(os.listdir(UPLOAD_DIR)):
        path = os.path.join(UPLOAD_DIR, fname)
        if os.path.isfile(path) and _is_video(fname):
            st = os.stat(path)
            items.append({
                "name": fname,
                "url": f"/static/videos/{fname}",  # direct static path
                "size": st.st_size,
                "mtime": int(st.st_mtime)
            })
    return jsonify({"items": items})

# Optional: allow uploads from the UI
@app.post('/videos')
def upload_video():
    f = request.files.get('file')
    if not f:
        return jsonify({"error": "missing file"}), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_EXTS:
        return jsonify({"error": "unsupported format"}), 400
    fname = secure_filename(f.filename)
    dest = os.path.join(UPLOAD_DIR, fname)
    f.save(dest)
    return jsonify({"ok": True, "name": fname, "url": f"/static/videos/{fname}"})



#------------html routes ------------
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/frame_extract')
def frame_extract():
    return send_from_directory('static', 'frame_extract.html')

@app.route('/shot_summary')
def shot_summary():
    return send_from_directory('static', 'shot_summary.html')

# ---------------------- Session API (demo-friendly) ----------------------
SESSIONS_DIR = os.path.join(app.root_path, 'sessions')
os.makedirs(SESSIONS_DIR, exist_ok=True)

def _session_path(sid: str):
    d = os.path.join(SESSIONS_DIR, sid)
    os.makedirs(d, exist_ok=True)
    return d

def _session_json_path(sid: str):
    return os.path.join(_session_path(sid), 'session.json')

def _read_session(sid: str):
    p = _session_json_path(sid)
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None

def _write_session(sid: str, data: dict):
    p = _session_json_path(sid)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def _new_session_id():
    return datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')

@app.post('/api/sessions/start')
def api_session_start():
    b = request.get_json() or {}
    sid = b.get('id') or _new_session_id()
    now = int(time.time()*1000)
    sess = {
        'id': sid,
        'startedAt': now,
        'endedAt': None,
        'device': b.get('device') or request.headers.get('User-Agent','unknown'),
        'video': b.get('video') or None,
        'shots': [],
        'totals': { 'attempts': 0, 'made': 0, 'accuracy': 0 }
    }
    _write_session(sid, sess)
    try:
        _db_add_session(sid, now)
    except Exception as e:
        _trace('db add session error:', e)
    _trace('api:sessions/start', {'sid': sid, 'device': sess.get('device')})
    return jsonify({ 'id': sid, 'startedAt': now })

@app.post('/api/sessions/<sid>/shot')
def api_session_add_shot(sid):
    data = request.get_json(force=True) or {}
    sess = _read_session(sid)
    if not sess:
        return jsonify({'error':'session not found'}), 404
    shots = list(sess.get('shots', []))
    client_idx = data.get('idx') if isinstance(data.get('idx'), int) else None
    replace = bool(data.get('replace'))
    # Determine next server index from both file and DB to avoid duplicate 0s
    next_idx = len(shots)
    try:
        db = _db_get()
        if db:
            from sqlalchemy import select, func
            with db['Session']() as s:
                ShotRow = db['ShotRow']
                mx = s.execute(select(func.max(ShotRow.idx)).where(ShotRow.sid == sid)).scalar_one_or_none()
                if mx is not None:
                    next_idx = max(next_idx, int(mx) + 1)
    except Exception as e:
        _trace('api:sid/shot: max idx probe failed:', e)
    _trace('api:sid/shot', {'sid': sid, 'idx': client_idx, 'replace': replace, 'serverNext': next_idx, 'keys': list(data.keys())})
    # Append by default; only replace when explicitly requested
    found_idx = None
    if replace and client_idx is not None:
        for i, srow in enumerate(shots):
            if isinstance(srow, dict) and srow.get('idx') == client_idx:
                found_idx = i
                break
    if found_idx is not None:
        data['idx'] = client_idx
        shots[found_idx] = data
    else:
        data['idx'] = next_idx
        shots.append(data)
    sess['shots'] = shots
    # update totals
    attempts = len(shots)
    made = sum(1 for s in shots if s.get('made') is True)
    acc = int(round((made/attempts)*100)) if attempts else 0
    sess['totals'] = { 'attempts': attempts, 'made': made, 'accuracy': acc }
    _write_session(sid, sess)
    try:
        _db_add_shot(sid, data['idx'], data)
    except Exception as e:
        _trace('db add shot error:', e)
    return jsonify({ 'ok': True, 'idx': data['idx'], 'totals': sess['totals'] })

@app.post('/api/sessions/<sid>/shot_video')
def api_session_shot_video(sid):
    if 'file' not in request.files:
        return jsonify({'error':'file field required'}), 400
    idx = request.args.get('index', '0')
    f = request.files['file']
    ext = os.path.splitext(f.filename)[1] or '.webm'
    d  = _session_path(sid)
    name = f'shot_{idx}{ext}'
    dst = os.path.join(d, name)
    f.save(dst)
    url = f'/sessions/{sid}/{name}'
    return jsonify({ 'ok': True, 'url': url, 'name': name })

@app.post('/api/sessions/<sid>/end')
def api_session_end(sid):
    sess = _read_session(sid)
    if not sess:
        return jsonify({'error':'session not found'}), 404
    sess['endedAt'] = int(time.time()*1000)
    # Recompute totals
    shots = sess.get('shots', [])
    attempts = len(shots)
    made = sum(1 for s in shots if s.get('made') is True)
    acc = int(round((made/attempts)*100)) if attempts else 0
    sess['totals'] = { 'attempts': attempts, 'made': made, 'accuracy': acc }
    _write_session(sid, sess)
    try:
        _db_finalize_session(sid)
    except Exception as e:
        _trace('db finalize error:', e)
    # Backfill DB shots from session.json to guarantee coverage
    try:
        _db_backfill_session_shots(sid)
    except Exception as e:
        _trace('db backfill error:', e)
    _trace('api:sessions/end', {'sid': sid, 'totals': sess['totals']})
    return jsonify({ 'ok': True, 'id': sid, 'totals': sess['totals'] })

@app.get('/api/sessions')
def api_sessions_list():
    items = []
    for sid in sorted(os.listdir(SESSIONS_DIR)):
        p = os.path.join(SESSIONS_DIR, sid, 'session.json')
        if os.path.exists(p):
            try:
                with open(p, 'r', encoding='utf-8') as f:
                    s = json.load(f)
                items.append({
                    'id': s.get('id', sid),
                    'startedAt': s.get('startedAt'),
                    'endedAt': s.get('endedAt'),
                    'totals': s.get('totals', {}),
                    'shots': len(s.get('shots', []))
                })
            except Exception:
                pass
    items.sort(key=lambda x: x.get('startedAt') or 0, reverse=True)
    return jsonify({ 'sessions': items })

@app.get('/api/sessions/<sid>')
def api_session_get(sid):
    sess = _read_session(sid)
    if not sess:
        return jsonify({'error':'session not found'}), 404
    return jsonify(sess)

@app.route('/sessions/<sid>/<path:filename>')
def serve_session_file(sid, filename):
    return send_from_directory(_session_path(sid), filename)

# ---- Frontend release mark bridge ----------------------------------------
@app.post('/api/release_mark')
def api_release_mark():
    try:
        data = request.get_json(force=True) or {}
        sid   = (data.get('sessionId') or data.get('sid') or '').strip() or None
        shot  = data.get('shotId') if isinstance(data.get('shotId'), int) else None
        frame = int(data.get('frame') or data.get('fidx') or 0)
        t_ms  = int(data.get('tMs') or data.get('t') or (time.time()*1000))
        via   = (data.get('via') or 'frontend').strip()
        snap  = data.get('poseSnapshot') or None
        hoop  = data.get('hoop') or None
        entry = {
            'ts': datetime.utcnow().isoformat(timespec='milliseconds')+'Z',
            'sessionId': sid,
            'shotId': shot,
            'frame': frame,
            'tMs': t_ms,
            'via': via,
            'poseSnapshot': snap,
            'hoop': hoop,
            'gate': data.get('gate') or None,
        }
        # Persist to session folder if present; else log in a global file
        if sid:
            d = _session_path(sid)
            p = os.path.join(d, 'releases.jsonl')
        else:
            os.makedirs(SESSIONS_DIR, exist_ok=True)
            p = os.path.join(SESSIONS_DIR, 'releases.jsonl')
        with open(p, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        # Also persist to SQL if configured
        try:
            db = getattr(app, 'db', None)
            if db and sid:
                with db['Session']() as sdb:
                    # store a pose snapshot row (create table below)
                    PoseSnap = db.get('PoseSnapshotRow')
                    if PoseSnap is not None:
                        row = PoseSnap(
                            sid=sid,
                            shot_idx=(shot or 0),
                            frame=frame,
                            t_ms=t_ms,
                            via=via,
                            metrics=snap,
                            hoop=hoop,
                            gate=entry.get('gate')
                        )
                        sdb.add(row)
                        sdb.commit()
        except Exception as e:
            print('db_add_pose_snapshot:', e)

        # Keep a simple in-memory mirror for quick debugging
        app.config['LAST_RELEASE'] = entry
        return jsonify({'ok': True, 'saved': True})
    except Exception as e:
        print('release_mark error:', e)
        return jsonify({'ok': False, 'error': str(e)}), 500


# ---------------------- Database (MySQL) -----------------------
Base = declarative_base() if SQLA_AVAILABLE else None
DBSessionLocal = None

def _try_init_db():
    global DBSessionLocal
    if not SQLA_AVAILABLE:
        return None
    try:
        load_dotenv()
        uri = (os.getenv('SQLALCHEMY_DATABASE_URI') or os.getenv('DATABASE_URI') or '').strip()
        if not uri:
            return None
        # On Windows, mysql-connector C extension can crash the interpreter.
        # Force pure-Python mode when using mysql+mysqlconnector to avoid access violations.
        if uri.startswith('mysql+mysqlconnector://'):
            engine = create_engine(
                uri,
                pool_pre_ping=True,
                future=True,
                connect_args={'use_pure': True}
            )
        else:
            engine = create_engine(uri, pool_pre_ping=True, future=True)

        class User(Base):
            __tablename__ = 'users'
            user_id = Column(Integer, primary_key=True, autoincrement=True)
            created_at = Column(DateTime, default=datetime.utcnow)
            status = Column(String(16), default='active')
            name = Column(String(100))
            password_hash = Column(String(255))
            email = Column(String(255))
            phone = Column(String(32))
            address = Column(String(255))
            birthday = Column(String(16))
            handle = Column(String(64))
            height_cm = Column(Integer)
            weight_kg = Column(Integer)
            sports = Column(MyJSON)
            goals  = Column(MyJSON)

        class SessionRow(Base):
            __tablename__ = 'sessions'
            sid = Column(String(64), primary_key=True)
            created_at = Column(DateTime, default=datetime.utcnow)
            ended_at = Column(DateTime)
            user_id = Column(Integer, ForeignKey('users.user_id'), nullable=True)
            shots_count = Column(Integer, default=0)
            makes = Column(Integer, default=0)
            accuracy = Column(Integer, default=0)
            entry_angle_avg = Column(Float)
            release_angle_avg = Column(Float)
            arc_height_avg = Column(Float)
            summary = Column(Text)
            status = Column(String(16), default='private')
            video_url = Column(String(512))
            user = relationship('User', lazy='joined')

        class ShotRow(Base):
            __tablename__ = 'shots'
            id = Column(Integer, primary_key=True, autoincrement=True)
            sid = Column(String(64), ForeignKey('sessions.sid'), nullable=False)
            idx = Column(Integer, nullable=False)
            created_at = Column(DateTime, default=datetime.utcnow)
            release_frame = Column(Integer)
            end_frame = Column(Integer)
            release_ms = Column(Integer)
            end_ms = Column(Integer)
            made = Column(Boolean)
            entry_angle = Column(Float)
            release_angle = Column(Float)
            arc_height = Column(Float)
            miss_reason = Column(String(128))
            clip_url = Column(String(512))
            data = Column(MyJSON)

        class PoseSnapshotRow(Base):
            __tablename__ = 'pose_snapshots'
            id = Column(Integer, primary_key=True, autoincrement=True)
            sid = Column(String(64), ForeignKey('sessions.sid'), nullable=False)
            shot_idx = Column(Integer, nullable=True)
            created_at = Column(DateTime, default=datetime.utcnow)
            frame = Column(Integer)
            t_ms = Column(Integer)
            via = Column(String(64))
            metrics = Column(MyJSON)   # poseSnapshot metrics JSON
            hoop = Column(MyJSON)      # hoop box JSON
            gate = Column(MyJSON)      # unified gate result/tests JSON

        class CoachFeedbackRow(Base):
            __tablename__ = 'ai_feedback'
            id = Column(Integer, primary_key=True, autoincrement=True)
            sid = Column(String(64), ForeignKey('sessions.sid'), nullable=True)
            shot_idx = Column(Integer, nullable=True)
            created_at = Column(DateTime, default=datetime.utcnow)
            provider = Column(String(64))
            model = Column(String(64))
            latency_ms = Column(Integer)
            text = Column(Text)

        Base.metadata.create_all(engine)
        DBSessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        # attach to app for reuse
        app.db = { 'engine': engine, 'Session': DBSessionLocal, 'User': User, 'SessionRow': SessionRow, 'ShotRow': ShotRow, 'PoseSnapshotRow': PoseSnapshotRow, 'CoachFeedbackRow': CoachFeedbackRow }
        print('✅ SQLAlchemy connected')
        return app.db
    except Exception as e:
        print('⚠️ DB init skipped:', e)
        return None

_try_init_db()

def _db_add_session(sid, started_at):
    try:
        db = getattr(app, 'db', None)
        if not db:
            return
        with db['Session']() as s:
            row = db['SessionRow'](sid=sid, created_at=datetime.utcfromtimestamp(started_at/1000.0))
            uid = session.get('user_id')
            if uid:
                row.user_id = uid
            s.add(row)
            s.commit()
    except Exception as e:
        print('db_add_session:', e)

def _db_add_shot(sid, idx, payload):
    try:
        db = getattr(app, 'db', None)
        if not db:
            return
        with db['Session']() as s:
            from sqlalchemy import select, func, case
            ShotRow = db['ShotRow']
            # Upsert by (sid, idx)
            existing = s.execute(select(ShotRow).where(ShotRow.sid == sid, ShotRow.idx == idx)).scalar_one_or_none()
            if existing is not None:
                m_in = payload.get('made')
                if m_in is not None:
                    existing.made = bool(m_in)
                existing.entry_angle = payload.get('entryAngle')
                existing.release_angle = payload.get('releaseAngle')
                existing.arc_height = payload.get('arcHeight')
                existing.miss_reason = payload.get('missReason')
                existing.data = payload
                row = existing
            else:
                m_in = payload.get('made')
                made_val = (None if m_in is None else bool(m_in))
                row = ShotRow(
                    sid=sid,
                    idx=idx,
                    made=made_val,
                    entry_angle=payload.get('entryAngle'),
                    release_angle=payload.get('releaseAngle'),
                    arc_height=payload.get('arcHeight'),
                    miss_reason=payload.get('missReason'),
                    data=payload,
                )
                s.add(row)

            # Ensure a session row exists, create if missing (idempotent)
            try:
                sess = s.get(db['SessionRow'], sid)
                if not sess:
                    sess = db['SessionRow'](sid=sid, created_at=datetime.utcnow())
                    s.add(sess)
            except Exception as e_sess:
                _trace('db_add_shot: ensure session error:', e_sess)

            # Ensure the shot row is persisted
            try:
                s.flush()
            except Exception as e_flush:
                _trace('db_add_shot: flush error:', e_flush)

            # Update totals if the session row exists; always commit at least the shot row
            try:
                sess = s.get(db['SessionRow'], sid)
                if sess:
                    total, makes = s.execute(
                        select(
                            func.count(ShotRow.id),
                            func.sum(case((ShotRow.made == True, 1), else_=0)),
                        ).where(ShotRow.sid == sid)
                    ).one()
                    sess.shots_count = int(total or 0)
                    sess.makes = int(makes or 0)
                    sess.accuracy = int(round((sess.makes / max(1, sess.shots_count)) * 100))
            except Exception as e_tot:
                _trace('db_add_shot: totals error:', e_tot)

            # Commit regardless of whether totals were updated
            s.commit()
            _trace('db:upsert:shot', {'sid': sid, 'idx': idx, 'made': row.made, 'arcHeight': row.arc_height, 'entryAngle': row.entry_angle, 'releaseAngle': row.release_angle})
    except Exception as e:
        _trace('db_add_shot:', e)

def _db_backfill_session_shots(sid: str):
    """Ensure DB has a ShotRow for every shot in session.json. Idempotent."""
    try:
        db = getattr(app, 'db', None)
        if not db:
            return
        sess_file = _read_session(sid) or {}
        shots = list(sess_file.get('shots') or [])
        if not shots:
            return
        with db['Session']() as s:
            from sqlalchemy import select
            ShotRow = db['ShotRow']
            have = set()
            for r in s.execute(select(ShotRow.idx).where(ShotRow.sid == sid)).scalars().all():
                try:
                    have.add(int(r))
                except Exception:
                    continue
            # Create missing rows
            created = 0
            for sh in shots:
                try:
                    i = int(sh.get('idx'))
                except Exception:
                    continue
                if i in have:
                    continue
                m_in = sh.get('made')
                row = ShotRow(
                    sid=sid,
                    idx=i,
                    made=(None if m_in is None else bool(m_in)),
                    entry_angle=sh.get('entryAngle'),
                    release_angle=sh.get('releaseAngle'),
                    arc_height=sh.get('arcHeight'),
                    miss_reason=sh.get('missReason'),
                    data=sh,
                )
                s.add(row)
                created += 1
            if created:
                try:
                    s.commit()
                except Exception:
                    s.rollback()
    except Exception as e:
        print('db_backfill_session_shots:', e)

def _db_finalize_session(sid):
    try:
        db = getattr(app, 'db', None)
        if not db:
            return
        with db['Session']() as s:
            sess = s.get(db['SessionRow'], sid)
            if sess:
                sess.ended_at = datetime.utcnow()
                s.commit()
    except Exception as e:
        print('db_finalize_session:', e)


# ---------------------- Auth (register/login/logout) ---------------------

def _db_get():
    return getattr(app, 'db', None)

@app.post('/api/auth/register')
def api_register():
    b = request.get_json(force=True) or {}
    name = (b.get('name') or '').strip()
    email = (b.get('email') or '').strip().lower()
    pw = (b.get('password') or '')
    if not email or not pw:
        return jsonify({'error':'email and password required'}), 400
    db = _db_get()
    if not db:
        return jsonify({'error':'db not configured'}), 500
    with db['Session']() as s:
        from sqlalchemy import select
        exists = s.execute(select(db['User']).where(db['User'].email==email)).scalar_one_or_none()
        if exists:
            return jsonify({'error':'email already registered'}), 409
        row = db['User'](name=name or email.split('@')[0], email=email, password_hash=generate_password_hash(pw))
        s.add(row)
        s.commit()
        session['user_id'] = row.user_id
        return jsonify({'user_id': row.user_id, 'name': row.name, 'email': row.email})

@app.post('/api/auth/login')
def api_login():
    b = request.get_json(force=True) or {}
    email = (b.get('email') or '').strip().lower()
    pw = (b.get('password') or '')
    db = _db_get()
    if not db:
        return jsonify({'error':'db not configured'}), 500
    from sqlalchemy import select
    with db['Session']() as s:
        row = s.execute(select(db['User']).where(db['User'].email==email)).scalar_one_or_none()
        if not row or not check_password_hash(row.password_hash or '', pw):
            return jsonify({'error':'invalid credentials'}), 401
        session['user_id'] = row.user_id
        return jsonify({'user_id': row.user_id, 'name': row.name, 'email': row.email})

@app.post('/api/auth/logout')
def api_logout():
    session.clear()
    return jsonify({'ok': True})

@app.get('/api/auth/me')
def api_me():
    uid = session.get('user_id')
    if not uid:
        return jsonify({'user': None})
    db = _db_get()
    if not db:
        return jsonify({'user': None})
    with db['Session']() as s:
        row = s.get(db['User'], uid)
        if not row:
            return jsonify({'user': None})
        return jsonify({'user': {'user_id': row.user_id, 'name': row.name, 'email': row.email}})

@app.route('/my_doach')
def my_doach():
    return send_from_directory('static', 'my_doach.html')

@app.route('/dashboard')
def dashboard():
    return send_from_directory('static', 'dashboard.html')

# Serve root favicon for browsers that request /favicon.ico
@app.route('/favicon.ico')
def favicon_root():
    try:
        return send_from_directory('static', 'favicon.ico')
    except Exception:
        return ('', 204)

@app.route('/d_admin')
def d_admin_page():
    return send_from_directory('static', 'd_admin.html')

# Serve development tools (e.g., arc_contract.js) to the client
@app.route('/tools/<path:filename>')
def serve_tools(filename):
    return send_from_directory('tools', filename)

# -- videos
@app.get("/api/videos")
def list_videos_api():
    return list_videos()

# ------------------------ coach routes --------------------------

# Voice presets: use global DATA_DIR/PRESET_FILE defined once at top

# Language names used in prompts/translations
LANG_NAMES = {
    "en-US": "English (United States)",
    "en-GB": "English (United Kingdom)",
    "en-AU": "English (Australia)",
    "es-ES": "Spanish (Spain)",
    "es-MX": "Spanish (Mexico)",
    "fr-FR": "French",
    "de-DE": "German",
    "pt-BR": "Portuguese (Brazil)",
    "it-IT": "Italian",
    "ja-JP": "Japanese",
    "ko-KR": "Korean",
    "zh-CN": "Chinese (Simplified)",
}

def _read_presets():
    if PRESET_FILE.exists():
        try:
            return json.loads(PRESET_FILE.read_text(encoding="utf-8"))
        except Exception:
            return []
    return []

def _write_presets(items):
    PRESET_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")

@app.get("/api/voice_presets")
def get_voice_presets():
    return jsonify({"presets": _read_presets()})

@app.post("/api/voice_presets")
def upsert_voice_preset():
    b = request.get_json() or {}
    p = b.get("preset") or {}
    if not p.get("name"):
        return jsonify({"error": "missing preset.name"}), 400
    items = _read_presets()
    i = next((k for k, it in enumerate(items) if it.get("name") == p["name"]), -1)
    if i >= 0:
        items[i] = p
    else:
        items.append(p)
    _write_presets(items)
    return jsonify({"ok": True, "preset": p})

@app.delete("/api/voice_presets/<name>")
def delete_voice_preset(name):
    items = [it for it in _read_presets() if it.get("name") != name]
    _write_presets(items)
    return jsonify({"ok": True})

def translate_if_needed(text: str, lang_code: str) -> str:
    """
    OpenAI TTS infers language from text. If user selected a non-US English
    locale or a non-English language, convert/translate first so speech sounds right.
    """
    if not lang_code or lang_code in ("en", "en-US"):
        return text

    client = get_openai_client()
    target = LANG_NAMES.get(lang_code, lang_code)

    if lang_code.startswith("en-"):
        system = (f"Convert the user's text to {target} with appropriate spelling/phrasing. "
                  "ONLY return the converted text.")
        user = text
    else:
        system = (f"Translate the user's text to {target}. Keep names/numbers. Natural for speech. "
                  "ONLY return the translation.")
        user = text

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        temperature=0.2,
    )
    out = (resp.choices[0].message.content or "").strip()
    return out or text

# Voices your server will accept (front-end should match these)
ALLOWED_VOICES = {
    "alloy", "verse", "amber", "aria", "coral", "sage", "vivid", "bright"
}

@app.post("/api/tts")
def api_tts():
    try:
        b = request.get_json(force=True) or {}
        text  = (b.get("text")  or "").strip()
        voice = (b.get("voice") or "alloy").strip().lower()
        lang  = (b.get("lang")  or "en-US").strip()

        if not text:
            return jsonify({"error": "text is required"}), 400
        if voice not in ALLOWED_VOICES:
            voice = "alloy"

        speak_text = translate_if_needed(text, lang)

        # Use OpenAI TTS (model name must be valid)
        r = requests.post(
            "https://api.openai.com/v1/audio/speech",
            headers={
                "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
                "Content-Type": "application/json",
                "Accept": "audio/mpeg"
            },
            json={"model": "gpt-4o-mini-tts", "voice": voice, "input": speak_text},
            stream=True, timeout=60
        )

        if r.status_code != 200:
            # Bubble API error details back to the client UI
            try:
                return jsonify(r.json()), r.status_code
            except Exception:
                return jsonify({"error": r.text}), r.status_code

        return Response(r.iter_content(8192), mimetype="audio/mpeg")

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.post("/api/coach")
def api_coach():
    b = request.get_json(force=True) or {}
    prompt   = (b.get("prompt")  or "").strip()
    model    =  b.get("model")   or "gpt-4o-mini"
    lang     =  b.get("lang")    or "en-US"
    shot     =  b.get("shot")
    profile  =  b.get("profile")
    sid      =  (b.get("sid") or b.get("sessionId") or '').strip() or None
    shot_idx =  b.get("shotId") if isinstance(b.get("shotId"), int) else None

    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    client = get_openai_client()
    lang_hint = "" if lang in ("en", "en-US") else f" Respond in {LANG_NAMES.get(lang, lang)}."

    system = (
        "You are Doach, a concise basketball shooting coach. "
        "Be supportive and specific; give 1–3 concrete cues (e.g., 'elbow under ball', "
        "'hold follow-through', 'higher arc' , 'feet placement', 'snap wrist', 'release point'). Keep it under ~6 sentences."
        + lang_hint
    )
    msgs = [{"role": "system", "content": system}]
    if profile:
        msgs.append({"role":"system","content": f"Player profile: {profile}"})
    if shot:
        msgs.append({"role":"system","content": f"Shot data: {shot}"})
    msgs.append({"role": "user",   "content": prompt})

    t0 = time.time()
    resp = client.chat.completions.create(model=model, messages=msgs, temperature=0.6)
    dt_ms = int((time.time() - t0) * 1000)
    text = (resp.choices[0].message.content or "").strip()

    # Persist feedback when DB is available; also mirror brief coach text into the shot's JSON data
    try:
        db = getattr(app, 'db', None)
        if db:
            with db['Session']() as sdb:
                FB = db.get('CoachFeedbackRow')
                if FB is not None:
                    row = FB(sid=sid, shot_idx=(shot_idx or 0), provider='openai', model=model, latency_ms=dt_ms, text=text)
                    sdb.add(row)
                # Mirror summary onto the shot row's JSON for easier joins later
                try:
                    if sid and isinstance(shot_idx, int):
                        Shot = db['ShotRow']
                        from sqlalchemy import select
                        sr = sdb.execute(select(Shot).where(Shot.sid==sid, Shot.idx==shot_idx)).scalar_one_or_none()
                        if sr is None:
                            # create a minimal row if missing
                            sr = Shot(sid=sid, idx=shot_idx, data={})
                            sdb.add(sr)
                        try:
                            d = dict(sr.data or {})
                            d['coach_summary'] = text
                            sr.data = d
                        except Exception:
                            sr.data = {'coach_summary': text}
                except Exception as e2:
                    print('coach mirror to shot failed:', e2)
                sdb.commit()
    except Exception as e:
        print('db_add_ai_feedback:', e)

    return jsonify({"text": text, "latency_ms": dt_ms})

#-----------app routes --------------
@app.route('/frames/<video_name>/<frame_file>')
def serve_frame(video_name, frame_file):
    return send_from_directory(os.path.join('frame_cache', video_name), frame_file)

@app.route('/test_openai')
def test_openai():
    try:
        get_openai_client().models.list()
        return jsonify({'status': '✅ OpenAI client working'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/list_frames/<video_name>')
def list_frames(video_name):
    folder_path = os.path.join('frame_cache', video_name)
    if not os.path.exists(folder_path):
        return jsonify({'error': 'Folder not found'}), 404

    frames = [f for f in os.listdir(folder_path) if f.endswith('.jpg')]
    frames.sort()
    return jsonify({'frames': frames})

# ---------------------- Admin Debug Views ----------------------

@app.get('/admin/sessions')
def admin_sessions():
    """List sessions with basic stats and user info when available."""
    items = []
    try:
        db = _db_get()
        if db:
            from sqlalchemy import select
            with db['Session']() as s:
                rows = s.execute(select(db['SessionRow'])).scalars().all()
                for r in rows:
                    items.append({
                        'sid': r.sid,
                        'created_at': r.created_at.isoformat() if r.created_at else None,
                        'ended_at': r.ended_at.isoformat() if r.ended_at else None,
                        'shots': r.shots_count,
                        'makes': r.makes,
                        'accuracy': r.accuracy,
                        'user': ({'user_id': r.user.user_id, 'name': r.user.name, 'email': r.user.email} if r.user else None)
                    })
        else:
            # Fallback to filesystem-only
            for sid in sorted(os.listdir(SESSIONS_DIR)):
                p = os.path.join(SESSIONS_DIR, sid, 'session.json')
                if os.path.exists(p):
                    try:
                        with open(p, 'r', encoding='utf-8') as f:
                            sdat = json.load(f)
                        items.append({
                            'sid': sid,
                            'created_at': sdat.get('startedAt'),
                            'ended_at': sdat.get('endedAt'),
                            'shots': len(sdat.get('shots', [])),
                            'user': None
                        })
                    except Exception:
                        pass
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'sessions': items})

@app.post('/api/sessions/<sid>/observer_frame')
def api_observer_frame(sid):
    """Accept low-FPS JPEG overlay snapshots from a client to aid real-time observing."""
    try:
        # Accept multipart file 'image' or JSON { image: 'data:image/jpeg;base64,...' }
        img_bytes = None
        if 'image' in request.files:
            f = request.files['image']
            img_bytes = f.read()
        else:
            b = request.get_json(silent=True) or {}
            data_url = b.get('image') or ''
            if data_url.startswith('data:image') and ';base64,' in data_url:
                img_bytes = base64.b64decode(data_url.split(',')[1])
        if not img_bytes:
            return jsonify({'error': 'no image'}), 400
        app.observer_frames[sid] = {'ts': int(time.time()*1000), 'bytes': img_bytes}
        # Best-effort write to disk for later review
        try:
            d = _session_path(sid)
            with open(os.path.join(d, 'observer_latest.jpg'), 'wb') as f:
                f.write(img_bytes)
        except Exception:
            pass
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.get('/admin/observe/<sid>.jpg')
def admin_observe_jpg(sid):
    rec = app.observer_frames.get(sid)
    if rec and rec.get('bytes'):
        return Response(rec['bytes'], mimetype='image/jpeg')
    # fallback to disk if present
    try:
        p = os.path.join(_session_path(sid), 'observer_latest.jpg')
        if os.path.exists(p):
            return send_file(p, mimetype='image/jpeg')
    except Exception:
        pass
    return jsonify({'error': 'no observer frame'}), 404

@app.get('/admin/observe/<sid>')
def admin_observe_page(sid):
    # Simple auto-refreshing viewer (client reloads every 600ms)
    html = f"""
<!doctype html>
<title>Observe {sid}</title>
<style>body{{margin:0;background:#111;color:#fff;font-family:system-ui}}#wrap{{display:flex;justify-content:center;align-items:center;height:100vh}}img{{max-width:96vw;max-height:94vh;box-shadow:0 10px 30px rgba(0,0,0,.4);border:1px solid #333}}</style>
<div id=\"wrap\"> 
  <img id=\"pic\" src=\"/admin/observe/{sid}.jpg?ts={int(time.time()*1000)}\" alt=\"observer\"/>
  <script>
    const img = document.getElementById('pic');
    setInterval(()=>{{ img.src = '/admin/observe/{sid}.jpg?ts=' + Date.now(); }}, 600);
  </script>
  </div>
"""
    return Response(html, mimetype='text/html')

@app.get('/admin/session/<sid>/debug')
def admin_session_debug(sid):
    """Return joined view: session.json + DB shots + pose_snapshots + ai_feedback + files"""
    out = {
        'sid': sid,
        'sessionFile': None,
        'user': None,
        'shotsDB': [],
        'snapshots': [],
        'feedback': [],
        'files': []
    }
    # session.json
    try:
        sdat = _read_session(sid)
        out['sessionFile'] = sdat
    except Exception:
        pass
    # files in session dir
    try:
        d = _session_path(sid)
        files = [f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))]
        out['files'] = sorted(files)
    except Exception:
        pass
    # DB parts
    try:
        db = _db_get()
        if db:
            from sqlalchemy import select
            with db['Session']() as s:
                # user from SessionRow
                sess = s.get(db['SessionRow'], sid)
                if sess and sess.user:
                    out['user'] = {'user_id': sess.user.user_id, 'name': sess.user.name, 'email': sess.user.email}
                # shots
                ShotRow = db['ShotRow']
                rows = s.execute(select(ShotRow).where(ShotRow.sid==sid).order_by(ShotRow.idx.asc())).scalars().all()
                out['shotsDB'] = [
                    {'idx': r.idx, 'made': r.made, 'entryAngle': r.entry_angle, 'releaseAngle': r.release_angle, 'arcHeight': r.arc_height,
                     'missReason': r.miss_reason, 'created_at': r.created_at.isoformat() if r.created_at else None}
                    for r in rows
                ]
                # pose snapshots
                PS = db.get('PoseSnapshotRow')
                if PS:
                    snaps = s.execute(select(PS).where(PS.sid==sid).order_by(PS.id.asc())).scalars().all()
                    out['snapshots'] = [
                        {'id': r.id, 'shot_idx': r.shot_idx, 'frame': r.frame, 't_ms': r.t_ms, 'via': r.via, 'metrics': r.metrics, 'hoop': r.hoop, 'gate': r.gate,
                         'created_at': r.created_at.isoformat() if r.created_at else None}
                        for r in snaps
                    ]
                # ai feedback
                FB = db.get('CoachFeedbackRow')
                if FB:
                    fbs = s.execute(select(FB).where(FB.sid==sid).order_by(FB.id.asc())).scalars().all()
                    out['feedback'] = [
                        {'id': r.id, 'shot_idx': r.shot_idx, 'provider': r.provider, 'model': r.model, 'latency_ms': r.latency_ms, 'text': r.text,
                         'created_at': r.created_at.isoformat() if r.created_at else None}
                        for r in fbs
                    ]
    except Exception as e:
        return jsonify({'error': str(e), 'partial': out}), 500
    # Opportunistic backfill when DB rows are missing but session.json has shots
    try:
        sf = out.get('sessionFile') or {}
        if sf and isinstance(sf.get('shots'), list):
            if len(out.get('shotsDB') or []) < len(sf['shots']):
                _db_backfill_session_shots(sid)
                # refresh minimal DB rows after backfill
                db = _db_get()
                if db:
                    from sqlalchemy import select
                    with db['Session']() as s:
                        ShotRow = db['ShotRow']
                        rows = s.execute(select(ShotRow).where(ShotRow.sid==sid).order_by(ShotRow.idx.asc())).scalars().all()
                        out['shotsDB'] = [
                            {'idx': r.idx, 'made': r.made, 'entryAngle': r.entry_angle, 'releaseAngle': r.release_angle, 'arcHeight': r.arc_height,
                             'missReason': r.miss_reason, 'created_at': r.created_at.isoformat() if r.created_at else None}
                            for r in rows
                        ]
    except Exception:
        pass
    # Fallback: read JSONL snapshots from filesystem if DB empty
    try:
        if not out['snapshots']:
            snaps = []
            # session-scoped JSONL
            p1 = os.path.join(_session_path(sid), 'releases.jsonl')
            # global JSONL
            p2 = os.path.join(SESSIONS_DIR, 'releases.jsonl')
            for p in (p1, p2):
                if os.path.exists(p):
                    with open(p, 'r', encoding='utf-8') as f:
                        for ln in f:
                            ln = ln.strip()
                            if not ln:
                                continue
                            try:
                                j = json.loads(ln)
                                if j.get('sessionId') and j.get('sessionId') != sid:
                                    continue
                                snaps.append({
                                    'frame': j.get('frame'), 't_ms': j.get('tMs') or j.get('t'), 'via': j.get('via'),
                                    'metrics': j.get('poseSnapshot'), 'hoop': j.get('hoop'), 'gate': j.get('gate'),
                                })
                            except Exception:
                                continue
            if snaps:
                out['snapshots'] = snaps
    except Exception as e:
        _trace('admin_session_debug: backfill error:', e)
    _trace('admin_session_debug', {'sid': sid, 'sessionFile': (len(out.get('sessionFile',{}).get('shots',[]) or [])), 'shotsDB': len(out.get('shotsDB') or []), 'feedback': len(out.get('feedback') or [])})
    return jsonify(out)

@app.get('/admin/users')
def admin_users():
    try:
        db = _db_get()
        users = []
        if db:
            from sqlalchemy import select, func
            with db['Session']() as s:
                U = db['User']; SR = db['SessionRow']
                rows = s.execute(select(U)).scalars().all()
                for u in rows:
                    cnt = s.execute(select(func.count(SR.sid)).where(SR.user_id==u.user_id)).scalar_one() or 0
                    users.append({'user_id': u.user_id, 'name': u.name, 'email': u.email, 'sessions': int(cnt)})
        return jsonify({'users': users, 'active': list(app.active_users.values())})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.get('/admin/user/<int:uid>/sessions')
def admin_user_sessions(uid):
    try:
        db = _db_get()
        items = []
        if db:
            from sqlalchemy import select
            with db['Session']() as s:
                SR = db['SessionRow']
                rows = s.execute(select(SR).where(SR.user_id==uid)).scalars().all()
                for r in rows:
                    items.append({'sid': r.sid, 'created_at': r.created_at.isoformat() if r.created_at else None, 'ended_at': r.ended_at.isoformat() if r.ended_at else None, 'shots': r.shots_count, 'accuracy': r.accuracy})
        return jsonify({'sessions': items})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# new frame extraction routes
@app.route('/save_yolo_label', methods=['POST'])
def save_yolo_label():
    data = request.get_json()
    folder = data.get('folder')
    filename = data.get('filename')
    content = data.get('content', '')

    folder_path = os.path.join('frames', folder)
    os.makedirs(folder_path, exist_ok=True)

    label_path = os.path.join(folder_path, filename)
    with open(label_path, 'w') as f:
        f.write(content.strip())
    return '', 200

# ---------- Extractor Rotation helper ----------
def _probe_video_rotation(video_path: str) -> int:
    """
    Returns 0/90/180/270 using ffprobe if available, else 0.
    """
    try:
        cmd = [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=side_data_list:stream_tags=rotate',
            '-of', 'json', video_path
        ]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            return 0
        data = json.loads(p.stdout)
        rot = 0
        streams = data.get('streams', [{}])
        s0 = streams[0] if streams else {}
        # tags.rotate (string degrees)
        tags = s0.get('tags', {})
        if 'rotate' in tags:
            rot = int(tags['rotate']) % 360
        # side_data_list.rotation (can be negative)
        sdl = s0.get('side_data_list', [])
        for ent in sdl:
            if 'rotation' in ent:
                r = int(ent['rotation'])
                rot = (r % 360 + 360) % 360
        if rot not in (0, 90, 180, 270):
            rot = 0
        return rot
    except Exception:
        return 0

def _cv2_rotate(img, degrees: int):
    if degrees == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if degrees == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if degrees == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img

def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v

def _rotate_yolo_label_line(line: str, degrees: int) -> str:
    """Rotate one YOLO xywh-normalized line (cid xc yc w h)."""
    parts = line.strip().split()
    if len(parts) != 5:
        return line
    cid, xc, yc, w, h = parts
    try:
        xc = float(xc)
        yc = float(yc)
        w = float(w)
        h = float(h)
    except Exception:
        return line
    if degrees == 90:
        x2, y2, w2, h2 = yc, 1.0 - xc, h, w
    elif degrees == 180:
        x2, y2, w2, h2 = 1.0 - xc, 1.0 - yc, w, h
    elif degrees == 270:
        x2, y2, w2, h2 = 1.0 - yc, xc, h, w
    else:
        x2, y2, w2, h2 = xc, yc, w, h
    x2 = _clamp01(x2)
    y2 = _clamp01(y2)
    w2 = _clamp01(w2)
    h2 = _clamp01(h2)
    return f"{cid} {x2:.6f} {y2:.6f} {w2:.6f} {h2:.6f}"

def _rotate_yolo_label_file_inplace(label_path: str, degrees: int):
    if not os.path.exists(label_path):
        return
    with open(label_path, 'r') as f:
        lines = [ln.strip() for ln in f if ln.strip()]
    out = [_rotate_yolo_label_line(ln, degrees) for ln in lines]
    with open(label_path, 'w') as f:
        f.write("\n".join(out) + ("\n" if out else ""))
# --------------------------------------

# Make sure compile_dataset copies images and labels to YOLO structure
@app.route('/compile_dataset/<folder>', methods=['POST'])
def compile_dataset(folder):
    import shutil

    data = request.get_json()
    yaml_text = data.get('yaml', '')

    base_path = os.path.join('datasets', 'doach_seg')
    img_dir = os.path.join(base_path, 'images', 'train')
    label_dir = os.path.join(base_path, 'labels', 'train')
    os.makedirs(img_dir, exist_ok=True)
    os.makedirs(label_dir, exist_ok=True)

    supported_exts = ('.jpg', '.jpeg', '.png', '.bmp')
    src_path = os.path.join('frames', folder)

    print(f"📂 Scanning: {src_path}")
    paired = 0

    for file in os.listdir(src_path):
        if not file.lower().endswith(supported_exts):
            continue
        name_no_ext = os.path.splitext(file)[0]
        label_file = name_no_ext + '.txt'

        img_src = os.path.join(src_path, file)
        lbl_src = os.path.join(src_path, label_file)

        if os.path.exists(lbl_src):
            shutil.copy2(img_src, os.path.join(img_dir, file))
            shutil.copy2(lbl_src, os.path.join(label_dir, label_file))
            paired += 1
        else:
            print(f"⚠️ Skipping {file} — no label found.")

    with open(os.path.join(base_path, 'data.yaml'), 'w') as f:
        f.write(yaml_text.strip())

    print(f"✅ Paired and copied {paired} image-label sets to {img_dir}")
    return '', 200

# replaces start_training - initiate training Yolo model
def _kickoff_training():
    try:
        yaml_path = os.path.join('datasets', 'doach_seg', 'data.yaml')
        run_name = f"doach_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        epochs   = 120
        imgsz    = 640
        batch    = 16
        workers  = 0
        model    = "yolov8s.pt"
        aug      = ("hsv_h=0.015 hsv_s=0.7 hsv_v=0.4 degrees=5 translate=0.08 "
                    "scale=0.20 shear=2 fliplr=0.5 perspective=0.0 close_mosaic=10")
        optim    = "optimizer=AdamW cos_lr=True"

        cmd = (
            f"yolo detect train model={model} data={yaml_path} project=runs/detect name={run_name} "
            f"epochs={epochs} imgsz={imgsz} batch={batch} workers={workers} "
            f"{aug} {optim} cache=True"
        )

        # used by your training monitor UI
        with open(TRAIN_STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump({'run': run_name, 'epochs': epochs, 'started_at': datetime.now().isoformat()}, f, indent=2)

        print("🚀 Running:", cmd)
        subprocess.Popen(cmd, shell=True)
        return jsonify({'status': '🚀 Training started.', 'run': run_name, 'epochs': epochs})
    except Exception as e:
        print("❌ Training failed:", e)
        return jsonify({'status': '❌ Training failed.', 'error': str(e)}), 500

# keep a route that accepts the old frontend shape with <folder>
@app.route('/start_training/<folder>')
def start_training(folder):
    return _kickoff_training()

# tolerant route without folder (frontend can call /start_training)
@app.route('/start_training', methods=['GET', 'POST'])
def start_training_noparam():
    return _kickoff_training()

@app.route('/manual_review/<video_name>')
def list_manual_review_frames(video_name):
    folder = os.path.join('frame_cache', video_name, 'manual_review')
    if not os.path.exists(folder):
        return jsonify({'frames': []})

    frames = [f for f in os.listdir(folder) if f.endswith('.jpg')]
    frames.sort()
    return jsonify({'frames': frames})

@app.route('/upload', methods=['POST'])
def upload():
    video = request.files.get('video')
    if video:
        filename = secure_filename(video.filename)
        path = os.path.join(UPLOAD_FOLDER, filename)
        video.save(path)
        frame_memory['ball_path'].clear()
        frame_memory['frame_id'] = 0
        global kalman
        kalman = init_kalman()
        return jsonify({'video': f'/uploads/{filename}'})
    return jsonify({'error': 'No video uploaded'}), 400

@app.route('/uploads/<filename>')
def serve_video(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

# 🧠 Kalman filter setup
kalman = None

def init_kalman():
    kf = cv2.KalmanFilter(4, 2)
    kf.transitionMatrix = np.array([[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=np.float32)
    kf.measurementMatrix = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=np.float32)
    kf.processNoiseCov = np.eye(4, dtype=np.float32) * 1e-2
    kf.measurementNoiseCov = np.eye(2, dtype=np.float32) * 1e-1
    kf.errorCovPost = np.eye(4, dtype=np.float32)
    return kf

def track_ball_with_kalman(ball_point):
    global kalman
    if ball_point:
        measured = np.array([[np.float32(ball_point['x'])], [np.float32(ball_point['y'])]])
        kalman.correct(measured)
    predicted = kalman.predict()
    return int(predicted[0]), int(predicted[1])

last_gray = None

def fallback_motion_ball(frame, min_area=30, max_area=5000):
    global last_gray
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 0)
    if last_gray is None:
        last_gray = gray
        return None
    frame_delta = cv2.absdiff(last_gray, gray)
    thresh = cv2.threshold(frame_delta, 20, 255, cv2.THRESH_BINARY)[1]
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = [cv2.boundingRect(c) for c in contours if min_area < cv2.contourArea(c) < max_area]
    if candidates:
        x, y, w, h = max(candidates, key=lambda r: r[2] * r[3])
        return {'x': x + w // 2, 'y': y + h // 2, 'frame': frame_memory['frame_id'], 'confidence': 0.5}  # set low for fast motion & net inclusion
    last_gray = gray
    return None

# run extract for every Nth frame (or every N seconds if provided)
@app.route('/extract_frames', methods=['POST'])
def extract_frames():
    data = request.get_json()
    filename = data.get('filename')
    step = int(data.get('step', 5))  # every N frames
    every_seconds = data.get('every_seconds')  # optional float (e.g., 0.5)
    if every_seconds is not None:
        try:
            every_seconds = float(every_seconds)
        except Exception:
            every_seconds = None

    if not filename:
        return jsonify({'error': 'Missing filename'}), 400

    video_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(video_path):
        return jsonify({'error': f'File not found: {video_path}'}), 404

    out_dir = os.path.join(FRAME_FOLDER, os.path.splitext(filename)[0])
    os.makedirs(out_dir, exist_ok=True)

    try:
        saved_filenames = extract_video_frames(video_path, out_dir, step=step, every_seconds=every_seconds)
        return jsonify({'frames': saved_filenames, 'count': len(saved_filenames)})
    except Exception as e:
        print("❌ extract_frames failed:", e)
        return jsonify({'error': f'Frame extraction failed: {str(e)}'}), 500


def extract_video_frames(video_path, out_dir, step=5, every_seconds=None):
    """
    Extract frames from video_path into out_dir.
    Auto-corrects orientation using ffprobe rotate metadata.
    If every_seconds is set, it overrides 'step' to sample by time.
    """
    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    # sampling stride
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_interval = int(round(fps * every_seconds)) if every_seconds else int(step)
    frame_interval = max(1, frame_interval)

    # auto-rotate based on metadata
    rotation = _probe_video_rotation(video_path)
    base_name = os.path.splitext(os.path.basename(video_path))[0]

    i = 0
    frame_id = 0
    saved = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if i % frame_interval == 0:
            if rotation:
                frame = _cv2_rotate(frame, rotation)
            filename = f'{base_name}_frame_{frame_id:03d}.jpg'
            cv2.imwrite(os.path.join(out_dir, filename), frame)
            saved.append(filename)
            frame_id += 1
        i += 1

    cap.release()
    return saved

@app.route('/rotate_frame', methods=['POST'])
def rotate_frame():
    """
    JSON body:
      folder   : <video folder in frame_cache>
      filename : <frame image filename, e.g., IMG_1234_frame_002.jpg>
      degrees  : 90|180|270
      rotate_labels : bool (optional, default false) - rotate frames/<folder>/<name>.txt if present
    """
    b = request.get_json(force=True) or {}
    folder   = b.get('folder')
    filename = b.get('filename')
    degrees  = int(b.get('degrees', 0)) % 360
    rotate_labels = bool(b.get('rotate_labels', False))

    if not folder or not filename or degrees not in (90, 180, 270):
        return jsonify({'error': 'folder, filename, and degrees (90|180|270) are required'}), 400

    img_path = os.path.join(FRAME_FOLDER, folder, filename)
    if not os.path.exists(img_path):
        return jsonify({'error': f'frame not found: {img_path}'}), 404

    img = cv2.imread(img_path)
    if img is None:
        return jsonify({'error': 'failed to read image'}), 500

    rotated = _cv2_rotate(img, degrees)
    cv2.imwrite(img_path, rotated)

    # Rotate corresponding YOLO label (optional)
    label_name = os.path.splitext(filename)[0] + '.txt'
    label_path = os.path.join('frames', folder, label_name)
    labels_rotated = False
    if rotate_labels and os.path.exists(label_path):
        try:
            _rotate_yolo_label_file_inplace(label_path, degrees)
            labels_rotated = True
        except Exception as e:
            print('⚠️ label rotate failed:', e)

    # Invalidate dataset copies (if they exist) to prevent stale training
    ds_lbl = os.path.join('datasets', 'doach_seg', 'labels', 'train', label_name)
    ds_img = os.path.join('datasets', 'doach_seg', 'images', 'train', filename)
    for p in (ds_lbl, ds_img):
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass

    return jsonify({'status': 'ok', 'rotated': degrees, 'labels_rotated': labels_rotated})

# Load a YOLO label from frames/<folder>/<filename>, with dataset fallback
@app.route('/load_yolo_label/<folder>/<path:filename>')
def load_yolo_label(folder, filename):
    """
    Search order:
      1) frames/<folder>/<filename>
      2) datasets/doach_seg/labels/train/<filename>  (fallback)
    Returns text/plain if found; otherwise 204 (no content).
    """
    # primary: frames/<folder>/<filename>
    frames_root = os.path.abspath(os.path.join(app.root_path, 'frames', folder))
    cand = os.path.abspath(os.path.join(frames_root, filename))
    if cand.startswith(frames_root) and os.path.exists(cand):
        return send_file(cand, mimetype='text/plain')

    # fallback: dataset label copy
    ds_root = os.path.abspath(os.path.join(app.root_path, 'datasets', 'doach_seg', 'labels', 'train'))
    ds_cand = os.path.abspath(os.path.join(ds_root, filename))
    if ds_cand.startswith(ds_root) and os.path.exists(ds_cand):
        return send_file(ds_cand, mimetype='text/plain')

    # keep console clean when no label exists yet
    return ('', 204)

#use openai to label objects in ea frame
@app.route('/label_frame', methods=['POST'])
def label_frame():
    data = request.get_json()
    path = data.get('path')

    if not path or not path.startswith('/frames/'):
        return jsonify({'error': 'Invalid path'}), 400

    abs_path = os.path.join('frame_cache', *path.split('/')[2:])
    if not os.path.exists(abs_path):
        return jsonify({'error': f'Frame not found: {abs_path}'}), 404

    try:
        # 🔍 Load image and encode to base64
        with open(abs_path, "rb") as f:
            img_bytes = f.read()
            b64_img = base64.b64encode(img_bytes).decode('utf-8')

        # 🧠 GPT prompt
        vision_prompt = {
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "Identify the basketball, hoop, player, net, and backboard in this frame. "
                    "For each object found, return a bounding box in normalized % coordinates "
                    "as: label: [x%, y%, width%, height%]. "
                    "Example:\n"
                    "basketball: [45%, 32%, 5%, 7%]\n"
                    "hoop: [50%, 20%, 15%, 10%]\n"
                    "player: [10%, 40%, 20%, 50%]\n"
                    "backboard: [45%, 32%, 5%, 7%]\n"
                    "net: [50%, 20%, 15%, 10%]"
                )},
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}}
            ]
        }

        response = get_openai_client().chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": (
                    "You are a helpful assistant trained to detect basketball scene objects and return bounding boxes."
                )},
                vision_prompt
            ],
            max_tokens=500
        )

        raw_text = response.choices[0].message.content.strip()
        boxes = parse_vision_boxes(raw_text)

        # ✅ Filter by confidence
        high_conf_boxes = [b for b in boxes if b.get('confidence', 1.0) >= CONFIDENCE_THRESHOLD]
        low_conf_labels = {b['label'] for b in boxes if b.get('confidence', 1.0) < CONFIDENCE_THRESHOLD}

        if len(high_conf_boxes) < len(REQUIRED_LABELS):
            print(f"⚠️ Frame has low confidence boxes: {low_conf_labels}")
            return move_to_manual_review(abs_path, boxes, reason="low confidence", extra=sorted(low_conf_labels))

        # ✅ Check for required labels
        found_labels = {b['label'] for b in high_conf_boxes}
        missing = REQUIRED_LABELS - found_labels

        if missing:
            print(f"⚠️ Frame missing required objects: {missing}")
            return move_to_manual_review(abs_path, high_conf_boxes, reason="missing labels", extra=sorted(missing))

        # ✅ Save label and return
        yolo_path = save_yolo_labels(abs_path, high_conf_boxes)
        # 🟡 Also copy label + image to YOLO training dataset
        train_label_dir = 'datasets/doach_seg/labels/train'
        train_image_dir = 'datasets/doach_seg/images/train'
        os.makedirs(train_label_dir, exist_ok=True)
        os.makedirs(train_image_dir, exist_ok=True)

        # Copy label
        shutil.copy(yolo_path, os.path.join(train_label_dir, os.path.basename(yolo_path)))

        # Copy image
        shutil.copy(abs_path, os.path.join(train_image_dir, os.path.basename(abs_path)))

        return jsonify({
            'summary': raw_text,
            'boxes': high_conf_boxes,
            'yolo_path': yolo_path
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'Vision labeling failed: {str(e)}'}), 500


#use openai to detect objects in the frame for extractor
@app.route('/auto_detect_frame_openai', methods=['POST'])
def auto_detect_frame_openai():
    """
    Body:  { folder: str, filename: str, confidence?: float }
    Return: { img_w:int, img_h:int, detections:[ {label,confidence,box:[x1,y1,x2,y2]}... ] }
            NOTE: box is in ORIGINAL image pixels (no 1280x720 mapping).
    """
    try:
        b = request.get_json(force=True) or {}
        folder   = b.get('folder')
        filename = b.get('filename')
        conf     = float(b.get('confidence', 0.20))

        # Prefer frame_cache (what UI shows)
        search_dirs = [
            os.path.join(app.root_path, 'frame_cache', folder),
            os.path.join(app.root_path, 'frames', folder),
            os.path.join('frame_cache', folder),
            os.path.join('frames', folder),
        ]
        image_path = None
        for d in search_dirs:
            p = os.path.join(d, filename)
            if os.path.exists(p):
                image_path = p
                break
        if not image_path:
            return jsonify({'error': f'Frame not found: {filename}'}), 404

        img = cv2.imread(image_path)
        if img is None:
            return jsonify({'error': 'Failed to read image'}), 500
        H, W = img.shape[:2]

        with open(image_path, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('utf-8')

        allowed = ['basketball','hoop','net','backboard','player']
        alias = {
            'rim': 'hoop', 'ring': 'hoop', 'goal': 'hoop', 'basket': 'hoop',
            'board': 'backboard', 'back board': 'backboard',
            'human': 'player', 'person': 'player',
            'net': 'net',
        }

        client = get_openai_client()
        prompt = (
            f"Detect ONLY these classes: {', '.join(allowed)}.\n"
            "Return STRICT JSON:\n"
            "{ \"detections\": [ {\"label\":\"<class>\", \"confidence\":0..1, \"box\":[x1,y1,x2,y2]} ] }\n"
            "Box MUST be pixel coords in the original image size "
            f"({W}x{H}), x1<x2, y1<y2. Use at most 3 boxes per class."
        )

        resp = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "Return ONLY the requested JSON."},
                {"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}
                ]}
            ],
            temperature=0.0,
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or "{}"
        try:
            js = json.loads(raw)
        except Exception:
            m = re.search(r'\{.*\}\s*$', raw, flags=re.S)
            js = json.loads(m.group(0)) if m else {"detections": []}

        dets_out = []
        for d in js.get("detections", []):
            lbl = (d.get("label") or "").strip().lower()
            lbl = alias.get(lbl, lbl)
            if lbl not in allowed:
                continue
            c = float(d.get("confidence", 0.0))
            if c < conf:
                continue

            box = d.get("box") or []
            if len(box) != 4:
                continue

            # Robust parse: support normalized [0..1], percent [0..100], or pixels
            x1, y1, x2, y2 = [float(v) for v in box]
            # Normalize weird orders
            if 0.0 <= x1 <= 1.0 and 0.0 <= x2 <= 1.0 and 0.0 <= y1 <= 1.0 and 0.0 <= y2 <= 1.0:
                # normalized [0..1]
                x1, x2 = x1 * W, x2 * W
                y1, y2 = y1 * H, y2 * H
            elif 0.0 <= x1 <= 100.0 and 0.0 <= x2 <= 100.0 and 0.0 <= y1 <= 100.0 and 0.0 <= y2 <= 100.0:
                # percentages
                x1, x2 = (x1/100.0) * W, (x2/100.0) * W
                y1, y2 = (y1/100.0) * H, (y2/100.0) * H
            # else: assume pixels already

            # sanitize / clamp & order
            x1, x2 = sorted([max(0, min(W-1, x1)), max(0, min(W-1, x2))])
            y1, y2 = sorted([max(0, min(H-1, y1)), max(0, min(H-1, y2))])
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue

            dets_out.append({
                "label": lbl,
                "confidence": round(c, 4),
                "box": [int(x1), int(y1), int(x2), int(y2)]
            })

        return jsonify({"img_w": int(W), "img_h": int(H), "detections": dets_out})

    except Exception as e:
        traceback.print_exc()
        if 'OPENAI_API_KEY' in str(e) or 'api_key' in str(e):
            return jsonify({'error': 'OPENAI_API_KEY missing or invalid'}), 400
        return jsonify({'error': str(e)}), 500


# use yolo to detect objects in frame for extractor
FRAME_DIR = os.path.join(app.root_path, 'frames')
ALT_FRAME_DIR = os.path.join(app.root_path, 'frame_cache')  # fallback if symbolic link used

@app.route('/auto_detect_frame', methods=['POST'])
def auto_detect_frame():
    data = request.get_json()
    folder   = data['folder']
    filename = data['filename']
    conf     = float(data.get('confidence', 0.15))  # setting for extractor auto detection

    # Prefer the bitmap the UI is showing (frame_cache first)
    search_dirs = [
        os.path.join(app.root_path, 'frame_cache', folder),
        os.path.join(app.root_path, 'frames', folder),
        os.path.join('frame_cache', folder),
        os.path.join('frames', folder),
    ]
    image_path = None
    for d in search_dirs:
        p = os.path.join(d, filename)
        if os.path.exists(p):
            image_path = p
            break
    if not image_path:
        return jsonify({'error': f'Frame not found: {filename}'}), 404

    try:
        img = cv2.imread(image_path)
        if img is None:
            return jsonify({'error': 'Failed to read image'}), 500
        H, W = img.shape[:2]

        # Single-threaded predict (Windows stability)
        with predict_lock:
            res = model_det.predict(image_path, conf=conf, imgsz=640, verbose=False)[0]

        names = getattr(getattr(model_det, 'model', None), 'names', None) or []
        dets = []
        for b in res.boxes:
            cid = int(b.cls[0])
            x1, y1, x2, y2 = map(float, b.xyxy[0].tolist())
            dets.append({
                'label': names[cid] if 0 <= cid < len(names) else f'class_{cid}',
                'confidence': float(b.conf[0]),
                # ORIGINAL image pixels — front-end will scale to the canvas
                'box': [int(x1), int(y1), int(x2), int(y2)]
            })

        return jsonify({'img_w': int(W), 'img_h': int(H), 'detections': dets})

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/fix_label_swap', methods=['POST'])
def fix_label_swap():
    """
    Body JSON: { "folder": "IMG_2830", "swap": [[2,4]] }
    Swaps class IDs in YOLO txt labels for frames/<folder>/*.txt
    and in matching dataset copies if present.
    """
    b = request.get_json(force=True) or {}
    folder = b.get('folder')
    swaps  = b.get('swap') or [[2,4]]
    if not folder:
        return jsonify({'error': 'folder required'}), 400

    frames_dir = os.path.join('frames', folder)
    if not os.path.isdir(frames_dir):
        return jsonify({'error': f'frames/{folder} not found'}), 404

    def swap_line(line: str) -> str:
        parts = line.strip().split()
        if len(parts) != 5:
            return line
        cid = int(parts[0])
        for a, b in swaps:
            if cid == a:
                cid = b
            elif cid == b:
                cid = a
        parts[0] = str(cid)
        return ' '.join(parts)

    changed = 0
    files = [f for f in os.listdir(frames_dir) if f.lower().endswith('.txt')]
    for fn in files:
        p = os.path.join(frames_dir, fn)
        try:
            with open(p, 'r') as f:
                lines = [ln.rstrip('\n') for ln in f]
            new_lines = [swap_line(ln) for ln in lines]
            if new_lines != lines:
                with open(p, 'w') as w:
                    w.write('\n'.join(new_lines) + ('\n' if new_lines else ''))
                changed += 1
                # also update dataset copy if exists
                ds_path = os.path.join('datasets', 'doach_seg', 'labels', 'train', fn)
                if os.path.exists(ds_path):
                    with open(ds_path, 'w') as w:
                        w.write('\n'.join(new_lines) + ('\n' if new_lines else ''))
        except Exception as e:
            print('swap failed for', p, e)

    return jsonify({'status': 'ok', 'folder': folder, 'files_changed': changed})

@app.route('/model_names')
def model_names():
    names = getattr(getattr(model_det, 'model', None), 'names', None)
    return jsonify({'names': names})



# Extractor UI panel helpers
# ---------- Training monitor ----------
TRAIN_STATE_PATH = os.path.join(STATIC_CONFIG_DIR, 'training_state.json')

def _latest_detect_run():
    if not os.path.exists(RUNS_DETECT_DIR):
        return None
    runs = [d for d in os.listdir(RUNS_DETECT_DIR)
            if os.path.isdir(os.path.join(RUNS_DETECT_DIR, d))]
    if not runs:
        return None
    runs.sort(key=lambda r: os.path.getmtime(os.path.join(RUNS_DETECT_DIR, r)), reverse=True)
    return runs[0]

@app.route('/train_status')
def train_status():
    run = _latest_detect_run()
    if not run:
        return jsonify({})
    run_dir = os.path.join(RUNS_DETECT_DIR, run)
    csv_path = os.path.join(run_dir, 'results.csv')
    weights_best = os.path.join(run_dir, 'weights', 'best.pt')

    out = {'run': run, 'epoch': 0, 'epochs': None, 'done': False}

    # try to read planned epochs from state file
    if os.path.exists(TRAIN_STATE_PATH):
        try:
            with open(TRAIN_STATE_PATH, 'r') as f:
                st = json.load(f)
                if st.get('run') == run:
                    out['epochs'] = st.get('epochs')
        except Exception:
            pass

    # read last row of results.csv
    if os.path.exists(csv_path):
        try:
            with open(csv_path, 'r', newline='') as f:
                rows = list(csv.DictReader(f))
            if rows:
                last = rows[-1]
                out['epoch'] = int(float(last.get('epoch', 0)))
                # losses
                tl = sum(float(last.get(k, 0.0)) for k in ('train/box_loss','train/cls_loss','train/dfl_loss'))
                vl = sum(float(last.get(k, 0.0)) for k in ('val/box_loss','val/cls_loss','val/dfl_loss'))
                out['loss_train'] = round(tl, 4)
                out['loss_val'] = round(vl, 4)
                # metrics
                out['map50'] = float(last.get('metrics/mAP50(B)', 0.0))
                out['map50_95'] = float(last.get('metrics/mAP50-95(B)', 0.0))
                # eta is not in csv; leave blank
        except Exception as e:
            print('train_status csv parse:', e)

    out['done'] = os.path.exists(weights_best)
    return jsonify(out)

@app.route('/train_stream')
def train_stream():
    def gen():
        last_epoch = -1
        while True:
            try:
                js = json.loads(train_status().response[0].decode())
                if js.get('epoch') != last_epoch:
                    last_epoch = js.get('epoch')
                    yield f"data: {json.dumps(js)}\n\n"
                if js.get('done'):
                    break
            except Exception:
                break
            time.sleep(2)
    return Response(gen(), mimetype='text/event-stream')

# serve results.png under /runs/detect/ so the UI <img> can load it
@app.route('/runs/detect/<path:subpath>')
def serve_runs_detect(subpath):
    return send_from_directory(os.path.join('runs', 'detect'), subpath)
# --------------------------------------


def _list_best_pt():
    """Return list of {run, pt_path, mtime} for runs/detect/*/weights/best.pt sorted by mtime desc."""
    pattern = os.path.join(RUNS_DETECT_DIR, '*', 'weights', 'best.pt')
    items = []
    for pt in glob.glob(pattern):
        try:
            st = os.stat(pt)
            items.append({
                'run': os.path.basename(os.path.dirname(os.path.dirname(pt))),  # run folder name
                'pt_path': pt,
                'mtime': st.st_mtime,
                'mtime_human': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M:%S')
            })
        except Exception:
            continue
    items.sort(key=lambda x: x['mtime'], reverse=True)
    return items

@app.route('/list_trained_models', methods=['GET'])
def list_trained_models():
    """Lists recent best.pt weights for convenience."""
    try:
        return jsonify({'models': _list_best_pt()})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/export_onnx', methods=['POST'])
def export_onnx():
    """
    Body JSON:
      pt_path   : string (optional; if absent, picks newest)
      imgsz     : int (default 640)
      opset     : int (default 17)
      profile   : string (default 'basketball')  # used to name output file
      simplify  : bool (default True)
      dynamic   : bool (default False)
      activate  : bool (default True)  # if true, writes static/config/detector.json to point worker at new model
    """
    try:
        data = request.get_json(force=True) or {}
        pt_path  = data.get('pt_path')
        imgsz    = int(data.get('imgsz', 640))
        opset    = int(data.get('opset', 17))
        profile  = (data.get('profile') or 'basketball').strip().lower()
        simplify = bool(data.get('simplify', True))
        dynamic  = bool(data.get('dynamic', False))
        activate = bool(data.get('activate', True))

        if not pt_path:
            models = _list_best_pt()
            if not models:
                return jsonify({'error': 'No best.pt found under runs/detect/*/weights/'}), 404
            pt_path = models[0]['pt_path']

        if not os.path.exists(pt_path):
            return jsonify({'error': f'pt not found: {pt_path}'}), 404

        # Export ONNX next to the PT (Ultralytics handles writing best.onnx)
        y = YOLO(pt_path)
        onnx_path = y.export(
            format='onnx',
            opset=opset,
            imgsz=imgsz,
            simplify=simplify,
            dynamic=dynamic
        )

        if not onnx_path or not os.path.exists(onnx_path):
            return jsonify({'error': 'Export did not produce an ONNX file.'}), 500

        # Copy into static/models with profile-based name
        dest_name = f'{profile}_best.onnx'
        dest_path = os.path.join(STATIC_MODELS_DIR, dest_name)
        shutil.copy2(onnx_path, dest_path)

        # Optionally activate by writing detector.json
        cfg = {
            'model_url': f'/static/models/{dest_name}',
            'imgsz': imgsz,
            'profile': profile,
            'updated_at': datetime.now().isoformat(timespec='seconds')
        }
        if activate:
            with open(DETECTOR_CFG_PATH, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2)

        return jsonify({
            'status': 'ok',
            'pt_path': pt_path,
            'onnx_exported': onnx_path,
            'model_copied_to': dest_path,
            'activated': activate,
            'detector_cfg': cfg if activate else None
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'ONNX export failed: {e}'}), 500

@app.route('/set_detector_model', methods=['POST'])
def set_detector_model():
    """Switch the active ONNX model without re-exporting."""
    try:
        data = request.get_json(force=True) or {}
        model_url = data.get('model_url')  # e.g. /static/models/basketball_best.onnx
        imgsz     = int(data.get('imgsz', 640))
        profile   = (data.get('profile') or 'basketball').strip().lower()

        if not model_url:
            return jsonify({'error': 'model_url required'}), 400

        cfg = {
            'model_url': model_url,
            'imgsz': imgsz,
            'profile': profile,
            'updated_at': datetime.now().isoformat(timespec='seconds')
        }
        with open(DETECTOR_CFG_PATH, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2)
        return jsonify({'status': 'ok', 'detector_cfg': cfg})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

# route to serve training labels
@app.route('/datasets/doach_seg/labels/train/<filename>')
def serve_dataset_label(filename):
    return send_from_directory('datasets/doach_seg/labels/train', filename)

# list_frame_folders route to populate dropdown on extraction page
@app.route('/list_frame_folders')
def list_frame_folders():
    import os
    root = os.path.join(app.root_path, 'frame_cache')
    folders = []
    if os.path.exists(root):
        folders = [f for f in os.listdir(root) if os.path.isdir(os.path.join(root, f))]
    return jsonify({ 'folders': sorted(folders) })

# ✅ Utility: Move rejected to manual_review/ and log it
def move_to_manual_review(abs_path, boxes, reason, extra=None):
    video_name = abs_path.split(os.sep)[1]
    manual_dir = os.path.join("frame_cache", video_name, "manual_review")
    os.makedirs(manual_dir, exist_ok=True)
    dest_path = os.path.join(manual_dir, os.path.basename(abs_path))
    shutil.move(abs_path, dest_path)

    # Move label file if it exists
    label_name = os.path.splitext(os.path.basename(abs_path))[0] + ".txt"
    label_path = os.path.join("labels", label_name)
    if os.path.exists(label_path):
        os.makedirs("labels/manual_review", exist_ok=True)
        shutil.move(label_path, os.path.join("labels/manual_review", label_name))

    # Log to skipped_frames.json
    log_skipped_frame(os.path.basename(abs_path), extra or [], reason)

    return jsonify({
        'summary': f"⚠️ Skipped: {reason.replace('_', ' ').title()}",
        'boxes': boxes,
        'skipped': True
    })


# ✅ Audit logger
def log_skipped_frame(frame_name, issues, reason):
    import json
    entry = {
        "frame": frame_name,
        "reason": reason,
        "details": issues
    }

    try:
        if os.path.exists(SKIPPED_LOG_PATH):
            with open(SKIPPED_LOG_PATH, 'r') as f:
                data = json.load(f)
        else:
            data = []

        data.append(entry)

        with open(SKIPPED_LOG_PATH, 'w') as f:
            json.dump(data, f, indent=2)

        print(f"📝 Logged skipped frame: {frame_name} → {reason}")
    except Exception as e:
        print(f"❌ Failed to log skipped frame: {e}")


# 📦 Utility: Extract bounding boxes from GPT output
def parse_vision_boxes(text):
    pattern = r"(\w+):\s*\[(\d+)%?,\s*(\d+)%?,\s*(\d+)%?,\s*(\d+)%?\]"
    boxes = []

    for match in re.findall(pattern, text):
        label, x, y, w, h = match
        boxes.append({
            'label': label.lower(),
            'x_pct': int(x),
            'y_pct': int(y),
            'w_pct': int(w),
            'h_pct': int(h)
        })

    return boxes

def save_yolo_labels(frame_path, boxes):
    label_dir = 'labels'
    os.makedirs(label_dir, exist_ok=True)

    frame_name = os.path.splitext(os.path.basename(frame_path))[0]
    label_path = os.path.join(label_dir, f"{frame_name}.txt")

    # read actual dims (not strictly needed for % → 0..1, but lets us clamp)
    img = cv2.imread(frame_path)
    H, W = (img.shape[0], img.shape[1]) if img is not None else (1, 1)

    with open(label_path, 'w') as f:
        for box in boxes:
            class_id = LABEL_TO_CLASS.get(box['label'], -1)
            if class_id == -1:
                continue

            # convert % top-left + size  → normalized center + size
            x_pct = float(box['x_pct'])
            y_pct = float(box['y_pct'])
            w_pct = float(box['w_pct'])
            h_pct = float(box['h_pct'])

            xc = (x_pct + w_pct / 2.0) / 100.0
            yc = (y_pct + h_pct / 2.0) / 100.0
            w  = w_pct / 100.0
            h  = h_pct / 100.0

            # clamp to [0,1] just in case
            xc = min(max(xc, 0.0), 1.0)
            yc = min(max(yc, 0.0), 1.0)
            w  = min(max(w,  0.0), 1.0)
            h  = min(max(h,  0.0), 1.0)

            f.write(f"{class_id} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")
    return label_path

@app.route('/review/accept', methods=['POST'])
def accept_reviewed_frame():
    data = request.get_json()
    video = data.get('video')
    frame = data.get('frame')

    frame_path = os.path.join("frame_cache", video, "manual_review", frame)
    label_path = os.path.join("labels", "manual_review", os.path.splitext(frame)[0] + ".txt")

    if not os.path.exists(frame_path):
        return jsonify({'error': 'Frame not found'}), 404

    dst_img = os.path.join("frame_cache", video, frame)
    dst_label = os.path.join("labels", os.path.basename(label_path))

    shutil.move(frame_path, dst_img)
    if os.path.exists(label_path):
        shutil.move(label_path, dst_label)

    return jsonify({'status': '✅ Accepted and moved to training'})

@app.route('/review/delete', methods=['POST'])
def delete_reviewed_frame():
    data = request.get_json()
    video = data.get('video')
    frame = data.get('frame')

    frame_path = os.path.join("frame_cache", video, "manual_review", frame)
    label_path = os.path.join("labels", "manual_review", os.path.splitext(frame)[0] + ".txt")

    if os.path.exists(frame_path):
        os.remove(frame_path)
    if os.path.exists(label_path):
        os.remove(label_path)

    return jsonify({'status': '🗑 Deleted from manual_review'})

# where the magic happens - what does the ai model see
@app.route('/detect_frame', methods=['POST'])
def detect_frame():
    if not TORCH_AVAILABLE or model_det is None:
        # Graceful fallback to let UI run with local ONNX worker
        return jsonify({'objects': [], 'frameIndex': 0, 'error': 'server-detector-unavailable'}), 200
    data = request.get_json()
    if not data or 'frame' not in data:
        return jsonify({'error': 'Missing frame'}), 400

    try:
        # Decode base64 image
        b64 = data['frame'].split(',')[-1]
        img_data = base64.b64decode(b64)
        frame = cv2.imdecode(np.frombuffer(img_data, np.uint8), cv2.IMREAD_COLOR)

        # Optional: crisp it up a bit
        sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        frame = cv2.filter2D(frame, -1, sharpen_kernel)
        frame = cv2.convertScaleAbs(frame, alpha=1.3, beta=15)

        # YOLO predict (low-ish conf; filter below by object)
        results = model_det.predict(frame, conf=0.22, imgsz=1280)[0]

        # Class ID -> label (must match training/export)
        label_map = {
            0: 'basketball',
            1: 'hoop',
            2: 'net',
            3: 'backboard',
            4: 'player'
        }

        # Per-class thresholds (tune as needed)
        class_conf_thresholds = {
            'basketball': 0.18,
            'hoop':       0.68,
            'backboard':  0.65,  
            'player':     0.45,  
            'net':        0.25   
        }

        detections = []
        for det in results.boxes:
            cls = int(det.cls[0])
            conf = float(det.conf[0])
            x1, y1, x2, y2 = map(int, det.xyxy[0])
            label = label_map.get(cls)
            if not label:
                continue
            if conf < class_conf_thresholds.get(label, 0.25):
                continue
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            detections.append({
                'label': label,
                'confidence': round(conf, 3),
                'x': cx,
                'y': cy,
                'box': [x1, y1, x2, y2]
            })

        # ---------- POST-PROCESS CORRECTIONS (runs BEFORE return) ----------
        # helpers
        def _w_h_ar(box):
            x1, y1, x2, y2 = box
            w = max(1, x2 - x1)
            h = max(1, y2 - y1)
            return w, h, w / float(h)

        def _iou(a, b):
            ax1, ay1, ax2, ay2 = a
            bx1, by1, bx2, by2 = b
            x1 = max(ax1, bx1)
            y1 = max(ay1, by1)
            x2 = min(ax2, bx2)
            y2 = min(ay2, by2)
            iw = max(0, x2 - x1)
            ih = max(0, y2 - y1)
            inter = iw * ih
            ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
            return inter / float(ua) if ua > 0 else 0.0

        bb = next((d for d in detections if d['label'] == 'backboard'), None)
        ho = next((d for d in detections if d['label'] == 'hoop'), None)

        # pass 1: flip player→net when it's flat & overlaps bb/hoop area
        for d in detections:
            if d['label'] != 'player':
                continue
            w, h, ar = _w_h_ar(d['box'])
            area = w * h
            near_bb = (bb and _iou(d['box'], bb['box']) > 0.15)
            near_ho = (ho and _iou(d['box'], ho['box']) > 0.08)
            if ar > 1.3 and (near_bb or near_ho):
                if not bb:
                    d['label'] = 'net'
                else:
                    bbw = bb['box'][2] - bb['box'][0]
                    bbh = bb['box'][3] - bb['box'][1]
                    if area < 0.35 * (bbw * bbh):
                        d['label'] = 'net'

        # pass 2: flip net→player when it's tall, bigger, and away from bb/hoop
        for d in detections:
            if d['label'] != 'net':
                continue
            w, h, ar = _w_h_ar(d['box'])
            area = w * h
            far_bb = (bb is None) or (_iou(d['box'], bb['box']) < 0.05)
            far_ho = (ho is None) or (_iou(d['box'], ho['box']) < 0.03)
            if ar < 0.9 and area > 3200 and far_bb and far_ho:
                d['label'] = 'player'

        # synthesize a hoop if missing (from net/backboard geometry)
        if not any(d['label'] == 'hoop' for d in detections):
            src = next((d for d in detections if d['label'] == 'net'), None) or \
                  next((d for d in detections if d['label'] == 'backboard'), None)
            if src:
                x1, y1, x2, y2 = src['box']
                w = max(1, x2 - x1)
                cx = (x1 + x2) // 2
                rim_w = max(40, int(0.55 * w))
                xL = int(cx - rim_w / 2)
                xR = int(cx + rim_w / 2)
                yR = int(y1)  # rim ≈ top of net
                detections.append({
                    'label': 'hoop',
                    'confidence': 0.51,
                    'x': cx,
                    'y': yR,
                    'box': [xL, yR - 4, xR, yR + 4],
                    'synthetic': True
                })
        # -------------------------------------------------------------------

        # (optional) quick label histogram for debugging
        # from collections import Counter
        # print("Counts:", Counter([d['label'] for d in detections]))

        return jsonify({
            'frameIndex': frame_memory['frame_id'],
            'objects': detections,
            'ball_path': frame_memory['ball_path']
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'YOLO detection failed: {str(e)}'}), 500
    
#------------------------------------------------------------------------------#
#                Start Training content for multiple sports
#------------------------------------------------------------------------------#
CURRENT_SPORT = 'basketball'
LABELS_PATH = os.path.join(app.root_path, 'static', 'models', 'labels.json')

def _load_labels_manifest():
    with open(LABELS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def _sport_profile_names(sport: str):
    man = _load_labels_manifest()
    prof = man['profiles'].get(sport, man['profiles']['basketball'])
    return prof  # list of label strings for that sport

def _sport_dataset_root(sport: str):
    return os.path.join('datasets', f'{sport}_seg')

@app.get('/get_labels')
def get_labels():
    sport = request.args.get('sport', CURRENT_SPORT).lower()
    names = _sport_profile_names(sport)
    return jsonify({'sport': sport, 'names': names})

@app.post('/set_sport')
def set_sport():
    global CURRENT_SPORT
    b = request.get_json(force=True) or {}
    s = (b.get('sport') or 'basketball').lower()
    CURRENT_SPORT = s
    names = _sport_profile_names(s)
    return jsonify({'sport': s, 'names': names, 'dataset_root': _sport_dataset_root(s)})

@app.route('/copy_label_to_dataset', methods=['POST'])
def copy_label_to_dataset():
    data = request.get_json()
    folder  = data.get('folder')
    filename = data.get('filename')
    image    = data.get('image')
    sport    = (data.get('sport') or CURRENT_SPORT).lower()

    src_txt = os.path.join('frames', folder, filename)
    src_img = os.path.join('frame_cache', folder, image)
    if not os.path.exists(src_img): 
        return jsonify({'error': f'missing image: {src_img}'}), 404

    base = _sport_dataset_root(sport)
    label_dst = os.path.join(base, 'labels', 'train', filename)
    image_dst = os.path.join(base, 'images', 'train', image)
    os.makedirs(os.path.dirname(label_dst), exist_ok=True)

    shutil.copy2(src_txt, label_dst)
    shutil.copy2(src_img, image_dst)
    return jsonify({'status': f'✅ Copied {filename} and {image} to {sport} training folders.'})

@app.get('/healthz')
def healthz():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    # Single process, single thread — avoids Windows resets
    host = os.getenv('HOST', '127.0.0.1')
    try:
        port = int(os.getenv('PORT', '5001'))
    except Exception:
        port = 5001
    print(f"Starting Doach server on http://{host}:{port}")
    try:
        app.run(host=host, port=port, debug=True, use_reloader=False, threaded=False)
    except OSError as e:
        alt = port + 1
        print(f"Port {port} unavailable ({e}); retrying on {alt}…")
        app.run(host=host, port=alt, debug=True, use_reloader=False, threaded=False)

# WSGI entrypoint for PythonAnywhere
application = app
