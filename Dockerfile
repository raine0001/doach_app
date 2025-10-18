# Base image includes Python, Node, Chromium, and all Playwright deps
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app

# Install Node.js 18 (for ArcMM runner) and clean up apt cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Install JS deps needed for the ArcMM runner (Playwright)
COPY package.json package-lock.json ./
RUN npm install --include=dev --omit=optional --loglevel warn

# Copy the rest of the project
COPY . .

# Render injects $PORT; gunicorn binds to it
ENV PORT=8080
ENV ARCMM_AUTO_PROCESS=1
ENV ARCMM_RUNNER_CMD="node scripts/arcmm_runner.js"
ENV ARCMM_RUNNER_TIMEOUT=90000

# Default entrypoint
CMD ["bash", "-c", "gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 3 --threads 8 app:app"]

