# detect_and_track.py

from ultralytics import YOLO
import cv2
import numpy as np
from filterpy.kalman import KalmanFilter

class KalmanFilter2D:
    def __init__(self):
        self.kf = KalmanFilter(dim_x=4, dim_z=2)
        self.kf.F = np.array([[1, 0, 1, 0],
                              [0, 1, 0, 1],
                              [0, 0, 1, 0],
                              [0, 0, 0, 1]])
        self.kf.H = np.array([[1, 0, 0, 0],
                              [0, 1, 0, 0]])
        self.kf.R *= 5
        self.kf.P *= 10
        self.kf.Q *= 0.01
        self.kf.x = np.zeros((4, 1))

    def update(self, pt):
        if pt is not None:
            z = np.array([[pt[0]], [pt[1]]])
            self.kf.predict()
            self.kf.update(z)
        else:
            self.kf.predict()
        return (int(self.kf.x[0]), int(self.kf.x[1]))


model = YOLO("weights/best.pt")
label_map = {0: "basketball", 1: "hoop", 2: "human"}

video_path = "videos/input_video.mp4"
cap = cv2.VideoCapture(video_path)
kf = KalmanFilter2D()
trajectory = []
hoop_box = None
scoring_zone = None
scored = False

# Prepare video output writer
ret, frame = cap.read()
height, width = frame.shape[:2]
out = cv2.VideoWriter('output.avi', cv2.VideoWriter_fourcc(*'XVID'), 20.0, (width, height))

cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # reset frame position

def draw_scoring_zone(frame, hoop_box):
    global scoring_zone
    if hoop_box is not None:
        x1, y1, x2, y2 = hoop_box
        zone_top = y2
        zone_bottom = y2 + 40
        zone_x1 = x1 + (x2 - x1) // 4
        zone_x2 = x2 - (x2 - x1) // 4
        scoring_zone = (zone_x1, zone_top, zone_x2, zone_bottom)
        cv2.rectangle(frame, (zone_x1, zone_top), (zone_x2, zone_bottom), (255, 0, 0), 2)

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        continue

    results = model.predict(frame, conf=0.25, verbose=False)
    detections = results[0].boxes

    ball_center = None
    for det in detections:
        cls_id = int(det.cls[0])
        label = label_map.get(cls_id, str(cls_id))
        x1, y1, x2, y2 = map(int, det.xyxy[0])

        print(f"Detected {label} at frame {int(cap.get(cv2.CAP_PROP_POS_FRAMES))}")

        if label == "basketball":
            ball_center = ((x1 + x2) // 2, (y1 + y2) // 2)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(frame, "ball", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

        if label == "hoop":
            hoop_box = (x1, y1, x2, y2)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 100, 100), 2)
            cv2.putText(frame, "hoop", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 100, 100), 2)

    smoothed = kf.update(ball_center)
    trajectory.append(smoothed)

    if hoop_box:
        draw_scoring_zone(frame, hoop_box)

    if scoring_zone and not scored:
        for pt in trajectory[-10:]:
            x, y = pt
            zx1, zy1, zx2, zy2 = scoring_zone
            if zx1 < x < zx2 and zy1 < y < zy2:
                cv2.putText(frame, "✅ Scored!", (x, y - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 3)
                scored = True
                break

    for i in range(1, len(trajectory)):
        cv2.line(frame, trajectory[i - 1], trajectory[i], (0, 255, 0), 2)

    out.write(frame)
    cv2.imshow("DOACH Shot Tracker", frame)

    if cv2.waitKey(50) & 0xFF == ord('q'):  # slow playback
        break

cap.release()
out.release()
cv2.destroyAllWindows()
