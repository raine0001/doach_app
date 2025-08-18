import os
import json
import shutil
import numpy as np
import cv2

LABELS = ['backboard', 'ball', 'hoop', 'net']  # Ensure order is consistent

input_dir = 'datasets/doach_seg/images/train'
output_images = 'datasets/doach_seg/images/train'  # Stays same
output_labels = 'datasets/doach_seg/labels/train'

os.makedirs(output_labels, exist_ok=True)

def create_mask(image_shape, points):
    mask = np.zeros(image_shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [np.array(points, dtype=np.int32)], color=1)
    return mask

def convert():
    for filename in os.listdir(input_dir):
        if not filename.endswith('.json'):
            continue

        json_path = os.path.join(input_dir, filename)
        with open(json_path, 'r') as f:
            data = json.load(f)

        image_path = os.path.join(input_dir, data['imagePath'])
        image = cv2.imread(image_path)
        height, width = image.shape[:2]

        label_file = os.path.join(output_labels, os.path.splitext(filename)[0] + '.txt')

        with open(label_file, 'w') as out:
            for shape in data['shapes']:
                label_name = shape['label']
                if label_name not in LABELS:
                    print(f"⚠️ Skipping unknown label: {label_name}")
                    continue

                label_id = LABELS.index(label_name)
                polygon = shape['points']

                # Normalize points
                norm_points = []
                for x, y in polygon:
                    nx, ny = x / width, y / height
                    norm_points.extend([nx, ny])

                out.write(f"{label_id} " + " ".join(map(str, norm_points)) + "\n")

        print(f"✅ Converted {filename}")

convert()
print("🎯 All annotations converted to YOLOv8 format.")
