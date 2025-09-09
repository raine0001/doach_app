import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Intention: validate background pre‑roll analysis while UI stays real‑time
// - Session starts via UI
// - Hidden pre‑detector processes frames continuously (~10 fps)
// - Shots produce POST /api/sessions/<sid>/shot and /shot_video
// - Visible video stays at ~1× playback

const BASE_URL = 'http://127.0.0.1:5001/';
const CLIP_PATH = process.env.DOACH_TEST_CLIP
  ? process.env.DOACH_TEST_CLIP
  : path.resolve('content/3shot_trim.mp4');

async function routeTestClip(page: Page) {
  const ext = path.extname(CLIP_PATH).toLowerCase();
  const contentType = ext === '.webm' ? 'video/webm'
                    : ext === '.mp4'  ? 'video/mp4'
                    : 'application/octet-stream';
  const clipBytes = fs.readFileSync(CLIP_PATH);
  await page.route('**/__test_clip__*', async route => {
    await route.fulfill({ status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, body: clipBytes });
  });
}

async function forceHoopLock(page: Page) {
  await page.evaluate(() => {
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement | null;
    const v  = document.getElementById('videoPlayer') as HTMLVideoElement | null;
    if (!cv || !v) throw new Error('missing overlay/video');
    const cx = (v.videoWidth || 1280) * 0.88;
    const cy = (v.videoHeight || 720) * 0.34;
    (window as any).__lockedHoopBox = { cx, cy, x: cx - 70, y: cy - 50, w: 140, h: 100 };
    (window as any).__hoopConfirmed = true;
    (window as any).getLockedHoopBox = () => (window as any).__lockedHoopBox;
  });
}

test.describe('Pre‑roll background analysis + session flow (10 fps)', () => {
  test.setTimeout(120_000);

  test('runs pre‑roll in background, posts shots, keeps UI 1×', async ({ page }) => {
    await routeTestClip(page);

    // Intercept API writes to observe payloads while letting app proceed
    const shots: any[] = [];
    const uploads: any[] = [];
    const starts: any[] = [];
    let sessionId: string | null = null;

    await page.route('**/api/sessions/*', async route => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.endsWith('/start') && method === 'POST') {
        const id = 'sess_' + Date.now();
        sessionId = id;
        starts.push({ when: Date.now(), body: await route.request().postDataJSON().catch(()=>({})) });
        return route.fulfill({ status: 200, json: { id, startedAt: Date.now() } });
      }
      if (/\/api\/sessions\/[^/]+\/shot$/.test(url) && method === 'POST') {
        const body = await route.request().postDataJSON();
        shots.push(body);
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      if (/\/api\/sessions\/[^/]+\/end$/.test(url) && method === 'POST') {
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      return route.fallback();
    });

    await page.route('**/api/sessions/*/shot_video', async route => {
      uploads.push({ when: Date.now(), url: route.request().url() });
      return route.fulfill({ status: 200, json: { ok: true } });
    });

    // Boot app in e2e mode
    await page.goto(BASE_URL + '?__e2e=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video#videoPlayer');
    await page.waitForSelector('#overlay, #videoCanvas');

    // Load clip
    await page.evaluate(() => {
      const v = document.getElementById('videoPlayer') as HTMLVideoElement;
      v.muted = true; (v as any).playsInline = true; v.preload = 'auto';
      v.src = '/__test_clip__?t=' + Date.now();
      v.load();
    });
    await page.waitForFunction(() => {
      const v = document.getElementById('videoPlayer') as HTMLVideoElement | null;
      return !!v && v.readyState >= 2 && v.videoWidth > 0;
    }, null, { timeout: 30_000 });

    // Force hoop lock; analyzer will follow
    await forceHoopLock(page);

    // Start session from the UI
    await page.click('#btnStartSession');

    // Ensure page marks session active and video plays 1×
    await page.evaluate(async () => { try { await (document.getElementById('videoPlayer') as HTMLVideoElement)?.play(); } catch {} });
    // Start analyzer explicitly for deterministic ticks in tests
    await page.evaluate(() => {
      const v = document.getElementById('videoPlayer') as HTMLVideoElement;
      const c = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
      (window as any).analyzeVideoFrameByFrame?.(v, c);
    });
    const rate = await page.evaluate(() => (document.getElementById('videoPlayer') as HTMLVideoElement)?.playbackRate || 0);
    expect(rate).toBeGreaterThan(0.95);

    // Verify pre‑detector is running and accumulating frames
    const before = await page.evaluate(() => (window as any).__PREDET?.ready || 0);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => (window as any).__PREDET?.ready || 0);
    expect(after).toBeGreaterThan(before);

    // Let one shot complete end‑to‑end
    await page.waitForFunction(() => {
      const list = (window as any).__shotList || [];
      return list.length >= 1;
    }, null, { timeout: 45_000 });

    // We should have received API writes: shot + clip upload
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    expect(sessionId).toBeTruthy();

    // Check that UI never left real‑time playback during the test window
    const rates = await page.evaluate(() => (window as any).__rateLog || []);
    // Not all pages record __rateLog; fall back to instantaneous rate checks
    const currentRate = await page.evaluate(() => (document.getElementById('videoPlayer') as HTMLVideoElement)?.playbackRate || 0);
    expect(currentRate).toBeGreaterThan(0.95);

    // End session via UI
    await page.click('#btnEndSession');
  });
});
