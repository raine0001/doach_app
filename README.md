# DOACH Web App

Cross-platform app for basketball shot analysis and coaching.

## Model Export

Create an ONNX model from a trained YOLO run:

```
yolo export model=runs\detect\doach_20250823_134837\weights\best.pt format=onnx opset=12 imgsz=640 simplify=True dynamic=True
```

Copy the exported model to `static/models/best.onnx` (optionally keep a backup at `static/models/backup_best.onnx`).

## ArcMM Headless Processing

The server can automatically run the ArcMM frame-by-frame pipeline for every captured shot:

- Install Playwright browsers once: `npx playwright install chromium`
- Set environment variables (see `sample.env`) and enable the worker with `ARCMM_AUTO_PROCESS=1`
- Configure the runner command, e.g. `ARCMM_RUNNER_CMD=node scripts/arcmm_runner.js`
- Ensure the Flask server is reachable at `ARCMM_BASE_URL` (defaults to `http://127.0.0.1:${PORT}`)
- Tune `ARCMM_WORKERS` (default `1`) to allow multiple sessions to be processed in parallel. Each session still runs sequentially on its own worker.

When enabled, each shot is enqueued after upload, rendered headlessly, and the summary plus overlay are written to `sessions/<sid>/processed/`.
