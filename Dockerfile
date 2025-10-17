# Base image includes Python, Node, Chromium, and all Playwright deps
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy the rest of the project
COPY . .

# Render injects $PORT; gunicorn binds to it
ENV PORT=8080
ENV ARCMM_AUTO_PROCESS=1
ENV ARCMM_RUNNER_CMD="node scripts/arcmm_runner.js"
ENV ARCMM_RUNNER_TIMEOUT=90000

# Default entrypoint
CMD ["gunicorn", "--bind", "0.0.0.0:${PORT}", "--workers", "3", "--threads", "8", "app:app"]
