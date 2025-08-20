# Unified DOACH app.py — optimized for dual model use, cleaned init, and removed /detect_video_init

from flask import Flask, request, Response, jsonify, send_from_directory, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename
import numpy as np
import requests
import cv2
import os
import torch
from ultralytics.nn.tasks import DetectionModel
from ultralytics import YOLO
import os
import base64
from openai import OpenAI
from dotenv import load_dotenv
import traceback
import re
import shutil
import subprocess
import json
from pathlib import Path
import io
import wave

torch.serialization.add_safe_globals([DetectionModel])

app = Flask(__name__, static_folder='static', static_url_path='/static')
CORS(app, resources={r"/api/*": {"origins": "*"}})

REQUIRED_LABELS = {'basketball', 'hoop', 'net', 'backboard', 'player'}
CONFIDENCE_THRESHOLD = 0.85
SKIPPED_LOG_PATH = 'skipped_frames.json'
UPLOAD_FOLDER = 'uploads'
FRAME_FOLDER = 'frame_cache'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(FRAME_FOLDER, exist_ok=True)

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)
PRESET_FILE = DATA_DIR / "voice_presets.json"

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

# 🔄 Load both models
BASE_DIR = Path(__file__).resolve().parent
# model_det = YOLO(BASE_DIR / "weights/best.pt")
model_det = YOLO(BASE_DIR / "weights/best.pt")
# model_seg = YOLO("training_output/doach_gpt_v1/weights/best.pt")          # Trained model
print("✅ Models loaded")

# 🧠 In-memory state
frame_memory = {'ball_path': [], 'frame_id': 0}


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

@app.route('/my_doach')
def my_doach():
    return send_from_directory('static', 'my_doach.html')

# -- videos
@app.get("/api/videos")
def list_videos_api():
    return list_videos()

# ------------------------ coach routes --------------------------

# Where we store named voice presets (JSON file on disk)
DATA_DIR = Path("data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
PRESET_FILE = DATA_DIR / "voice_presets.json"

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
    prompt  = (b.get("prompt")  or "").strip()
    model   =  b.get("model")   or "gpt-4o-mini"
    lang    =  b.get("lang")    or "en-US"
    shot    =  b.get("shot")
    profile =  b.get("profile")

    if not prompt:
        return jsonify({"error": "prompt is required"}), 400

    client = get_openai_client()
    lang_hint = "" if lang in ("en", "en-US") else f" Respond in {LANG_NAMES.get(lang, lang)}."

    system = (
        "You are Doach, a concise basketball shooting coach. "
        "Be supportive and specific; give 1–3 concrete cues (e.g., 'elbow under ball', "
        "'hold follow-through', 'higher arc'). Keep it under ~6 sentences."
        + lang_hint
    )
    msgs = [{"role": "system", "content": system}]
    if profile:
        msgs.append({"role":"system","content": f"Player profile: {profile}"})
    if shot:
        msgs.append({"role":"system","content": f"Shot data: {shot}"})
    msgs.append({"role": "user",   "content": prompt})

    resp = client.chat.completions.create(model=model, messages=msgs, temperature=0.6)
    text = (resp.choices[0].message.content or "").strip()
    return jsonify({"text": text})


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


# ✅ Patch: Make sure compile_dataset copies images and labels to YOLO structure
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




@app.route('/start_training/<folder>')
def start_training(folder):
    try:
        # Make sure to point to the correct data.yaml
        yaml_path = os.path.join('datasets', 'doach_seg', 'data.yaml')
        command = f"yolo task=detect mode=train model=yolov8n.pt data={yaml_path} name=doach_gpt_v13 epochs=60 imgsz=640"

        print("🚀 Running:", command)
        subprocess.Popen(command, shell=True)
        return jsonify({ 'status': '🚀 Training started.' })
    except Exception as e:
        print(f"❌ Training failed: {e}")
        return jsonify({ 'status': '❌ Training failed.' })




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
        return {'x': x + w // 2, 'y': y + h // 2, 'frame': frame_memory['frame_id'], 'confidence': 0.05}
    last_gray = gray
    return None

# run extract for every 5th frame from training video
@app.route('/extract_frames', methods=['POST'])
def extract_frames():
    data = request.get_json()
    filename = data.get('filename')
    if not filename:
        return jsonify({'error': 'Missing filename'}), 400

    video_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.exists(video_path):
        return jsonify({'error': f'File not found: {video_path}'}), 404

    out_dir = os.path.join(FRAME_FOLDER, os.path.splitext(filename)[0])
    os.makedirs(out_dir, exist_ok=True)

    try:
        saved_filenames = extract_video_frames(video_path, out_dir, step=5)
        return jsonify({
            'frames': saved_filenames,
            'count': len(saved_filenames)
        })
    except Exception as e:
        print("❌ extract_frames failed:", e)
        return jsonify({'error': f'Frame extraction failed: {str(e)}'}), 500


# Utility: frame extractor
def extract_video_frames(video_path, out_dir, step=5):
    import cv2
    import os

    os.makedirs(out_dir, exist_ok=True)
    cap = cv2.VideoCapture(video_path)

    i = 0
    frame_id = 0
    saved = []

    base_name = os.path.splitext(os.path.basename(video_path))[0]  # e.g., IMG_3033

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        if i % step == 0:
            filename = f'{base_name}_frame_{frame_id:03d}.jpg'
            cv2.imwrite(os.path.join(out_dir, filename), frame)
            saved.append(filename)
            frame_id += 1
        i += 1

    cap.release()
    return saved

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


@app.route('/copy_label_to_dataset', methods=['POST'])
def copy_label_to_dataset():
    data = request.get_json()
    folder = data.get('folder')
    filename = data.get('filename')
    image = data.get('image')

    src_txt = os.path.join('frames', folder, filename)
    src_img = os.path.join('frame_cache', folder, image)

    label_dst = os.path.join('datasets/doach_seg/labels/train', filename)
    image_dst = os.path.join('datasets/doach_seg/images/train', image)

    os.makedirs(os.path.dirname(label_dst), exist_ok=True)
    os.makedirs(os.path.dirname(image_dst), exist_ok=True)

    shutil.copy2(src_txt, label_dst)
    shutil.copy2(src_img, image_dst)

    return jsonify({ 'status': f'✅ Copied {filename} and {image} to training folders.' })

# use yolo to detect objects in frame for extractor
FRAME_DIR = os.path.join(app.root_path, 'frames')
ALT_FRAME_DIR = os.path.join(app.root_path, 'frame_cache')  # fallback if symbolic link used

@app.route('/auto_detect_frame', methods=['POST'])
def auto_detect_frame():

    data = request.get_json()
    folder = data['folder']
    filename = data['filename']

    search_dirs = [
        os.path.join(app.root_path, 'frames', folder),
        os.path.join(app.root_path, 'frame_cache', folder),
        os.path.join('frames', folder),
        os.path.join('frame_cache', folder)
    ]

    image_path = None
    print(f"🔍 Resolving image for: {filename}")
    for d in search_dirs:
        candidate = os.path.join(d, filename)
        print("   ➤ Checking:", candidate)
        if os.path.exists(candidate):
            image_path = candidate
            print(f"✅ Found: {image_path}")
            break

    if not image_path:
        print("❌ Not found in any listed paths.")
        return jsonify({ 'error': f"Frame not found: {filename}" }), 500

    try:
        model = YOLO("runs/detect/doach_gpt_v138/weights/best.pt")
        model.model.names = ['basketball', 'hoop', 'net', 'backboard', 'player']  # must assign to model.model.names

        results = model.predict(image_path, conf=0.05, imgsz=1280)[0]
        img = cv2.imread(image_path)
        orig_h, orig_w = img.shape[:2]

        detections = []
        for box in results.boxes:
            cls_id = int(box.cls[0])
            label = model.names[cls_id] if cls_id < len(model.names) else f'class_{cls_id}'
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            detections.append({
                'label': label,
                'box': [
                    int(x1 * (1280 / orig_w)),
                    int(y1 * (720 / orig_h)),
                    int(x2 * (1280 / orig_w)),
                    int(y2 * (720 / orig_h))
                ]
            })

        return jsonify(detections)

    except Exception as e:
        return jsonify({ 'error': str(e) }), 500
    
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

    with open(label_path, 'w') as f:
        for box in boxes:
            class_id = LABEL_TO_CLASS.get(box['label'], -1)
            if class_id == -1:
                continue
            x = box['x_pct'] / 100
            y = box['y_pct'] / 100
            w = box['w_pct'] / 100
            h = box['h_pct'] / 100
            f.write(f"{class_id} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
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
    data = request.get_json()
    if not data or 'frame' not in data:
        return jsonify({'error': 'Missing frame'}), 400
    
    # print("🔍 Received frame:", len(data['frame']))
    # print("📏 Resolution:", data.get("width"), data.get("height"))

    try:
        # 🔄 Decode base64 image
        b64 = data['frame'].split(',')[-1]
        img_data = base64.b64decode(b64)
        frame = cv2.imdecode(np.frombuffer(img_data, np.uint8), cv2.IMREAD_COLOR)
        # print("✅ Frame decoded:", frame.shape)


        # ✨ Optional: enhance contrast/sharpness
        sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
        frame = cv2.filter2D(frame, -1, sharpen_kernel)
        frame = cv2.convertScaleAbs(frame, alpha=1.3, beta=15)

        # 🧠 YOLO predict (low conf to capture all, we’ll filter manually)
        results = model_det.predict(frame, conf=0.15, imgsz=1280)[0]
        # print("🧪 Raw YOLO results:", results.boxes)


        # 🔢 Your training class map — update if model class IDs differ
        label_map = {
            0: 'basketball',
            1: 'hoop',
            2: 'player',
            4: 'net'
        }

        # 🎯 Object-specific confidence filtering
        class_conf_thresholds = {
            'basketball': 0.41,
            'hoop': 0.10,
            'player': 0.33,
            'net': 0.10
        }

        detections = []
        for det in results.boxes:
            cls = int(det.cls[0])
            conf = float(det.conf[0])
            x1, y1, x2, y2 = map(int, det.xyxy[0])

            label = label_map.get(cls)
            
            # print(f"🔍 Detected class {cls} → {label}, conf={conf:.2f}, box=({x1},{y1},{x2},{y2})")

            if not label:
                # print("⏭ Skipping: class not in label_map")
                continue  # 🗑 Skip untracked class like 'backboard'

            if conf < class_conf_thresholds.get(label, 0.25):
                # print(f"⏭ Skipping {label}: conf {conf:.2f} < threshold {class_conf_thresholds[label]}")
                continue  # 🧼 Too weak, discard

            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2

            detections.append({
                'label': label,
                'confidence': round(conf, 3),
                'x': cx,
                'y': cy,
                'box': [x1, y1, x2, y2]
            })

        return jsonify({
            'frameIndex': frame_memory['frame_id'],
            'objects': detections,
            'ball_path': frame_memory['ball_path']
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'YOLO detection failed: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5001)

# WSGI entrypoint for PythonAnywhere
application = app