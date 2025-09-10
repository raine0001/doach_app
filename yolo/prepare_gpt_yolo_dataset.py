import os
import shutil
import random

LABELS = ['basketball', 'hoop', 'player', 'backboard', 'net']

SRC_FRAMES = "frame_cache"
SRC_LABELS = "labels"

BASE_DIR = "datasets/doach_seg"
IMG_TRAIN = os.path.join(BASE_DIR, "images", "train")
IMG_VAL = os.path.join(BASE_DIR, "images", "val")
LBL_TRAIN = os.path.join(BASE_DIR, "labels", "train")
LBL_VAL = os.path.join(BASE_DIR, "labels", "val")

for d in [IMG_TRAIN, IMG_VAL, LBL_TRAIN, LBL_VAL]:
    os.makedirs(d, exist_ok=True)

def collect_gpt_frames():
    pairs = []

    for session in os.listdir(SRC_FRAMES):
        session_path = os.path.join(SRC_FRAMES, session)
        if not os.path.isdir(session_path):
            continue

        for file in os.listdir(session_path):
            if not file.endswith(".jpg"):
                continue

            img_path = os.path.join(session_path, file)
            base = os.path.splitext(file)[0]
            label_path = os.path.join(SRC_LABELS, base + ".txt")

            if os.path.exists(label_path):
                pairs.append((img_path, label_path))
            else:
                print(f"⚠️ No label for {file}")

    return pairs

def copy_pairs(pairs, img_dst, lbl_dst):
    for img_path, lbl_path in pairs:
        filename = os.path.basename(img_path)
        labelname = os.path.basename(lbl_path)

        shutil.copy2(img_path, os.path.join(img_dst, filename))
        shutil.copy2(lbl_path, os.path.join(lbl_dst, labelname))

def write_yaml():
    yaml_path = os.path.join(BASE_DIR, "data.yaml")
    with open(yaml_path, "w") as f:
        f.write("train: images/train\n")
        f.write("val: images/val\n\n")
        f.write(f"nc: {len(LABELS)}\n")
        f.write(f"names: {LABELS}\n")
    print(f"📝 data.yaml written to: {yaml_path}")

def prepare_dataset():
    pairs = collect_gpt_frames()
    random.shuffle(pairs)

    split = int(len(pairs) * 0.8)
    train_pairs = pairs[:split]
    val_pairs = pairs[split:]

    copy_pairs(train_pairs, IMG_TRAIN, LBL_TRAIN)
    copy_pairs(val_pairs, IMG_VAL, LBL_VAL)

    print(f"✅ {len(train_pairs)} training pairs copied.")
    print(f"✅ {len(val_pairs)} validation pairs copied.")
    write_yaml()

if __name__ == "__main__":
    prepare_dataset()
