# Use Python 3.11 slim as base
FROM python:3.11-slim
# Set working directory
WORKDIR /app
# Install system dependencies required for OpenCV and Playwright
RUN apt-get update && apt-get install -y \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*
# Copy requirements first to leverage Docker cache
COPY requirements.txt .
# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt
# Install Playwright browsers
RUN playwright install chromium
# Copy application code
COPY . .
# Expose port
EXPOSE 5001
# Set environment variables
ENV FLASK_APP=app.py
ENV FLASK_ENV=production
# Run the application
CMD ["flask", "run", "--host=0.0.0.0", "--port=5001"]