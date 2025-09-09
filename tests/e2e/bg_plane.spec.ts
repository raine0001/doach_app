import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

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
    const v = document.getElementById('videoPlayer') as HTMLVideoElement | null;
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement | null;
    if (!v || !cv) throw new Error('missing video/overlay');
    const cx = (v.videoWidth || 1280) * 0.88;
    const cy = (v.videoHeight || 720) * 0.34;
    (window as any).__lockedHoopBox = { cx, cy, x: cx - 70, y: cy - 50, w: 140, h: 100 };
    (window as any).__hoopConfirmed = true;
    (window as any).getLockedHoopBox = () => (window as any).__lockedHoopBox;
  });
}

test.describe('Background FBF plane (dev HUD + accuracy checks)', () => {
  test.setTimeout(120_000);

  test('stamps release, builds arc, exits below net, posts summary + clip', async ({ page }) => {
    await routeTestClip(page);

    // Observe API calls
    const shots: any[] = [];
    const uploads: any[] = [];
    await page.route('**/api/sessions/*', async route => {
      const url = route.request().url();
      const method = route.request().method();
      if (url.endsWith('/start') && method === 'POST') {
        const id = 'sess_' + Date.now();
        return route.fulfill({ status: 200, json: { id, startedAt: Date.now() } });
      }
      if (/\/api\/sessions\/[^/]+\/shot$/.test(url) && method === 'POST') {
        shots.push(await route.request().postDataJSON());
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      if (/\/api\/sessions\/[^/]+\/end$/.test(url) && method === 'POST') {
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      return route.fallback();
    });
    await page.route('**/api/sessions/*/shot_video', async route => {
      uploads.push({ url: route.request().url() });
      return route.fulfill({ status: 200, json: { ok: true } });
    });

    // Load with background plane enabled
    await page.goto(BASE_URL + '?__bg=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video#videoPlayer');
    await page.waitForSelector('#overlay, #videoCanvas');

    // Load clip and size overlay
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

    await forceHoopLock(page);

    // Start session so posts are emitted at summary
    await page.click('#btnStartSession');

    // Analyzer is started by ?__bg=1 hook and FBF pump will drive frames at 10 fps
    // 1) release frame stamped
    const relFrame = await page.waitForFunction(() => (window as any).ballState?.releaseFrame ?? null, null, { timeout: 45_000 });
    expect(typeof relFrame.value()).toBe('number');

    // 2) exit frame stamped and arc built with sufficient points
    const exitFrame = await page.waitForFunction(() => (window as any).ballState?.proxExitFrame ?? null, null, { timeout: 60_000 });
    expect(typeof exitFrame.value()).toBe('number');

    const arcPoints = await page.evaluate(() => {
      const t = (window as any).ballArc?.trail || [];
      return Array.isArray(t) ? t.length : 0;
    });
    expect(arcPoints).toBeGreaterThan(4);

    // 3) exit strictly below rimBottom + margin
    const belowOK = await page.evaluate(() => {
      const w: any = window;
      const H = w.getLockedHoopBox?.(); if (!H) return false;
      const C = (typeof w.canonHoop === 'function') ? w.canonHoop(H) : { cx: H.cx, cy: H.cy, w: H.w, h: H.h, rimTop: (H.cy - (H.h||0)/2) };
      const rimBottom = C.rimTop + C.h;
      const margin = Number(w.EXIT_BELOW_MARGIN || 12);
      const pts = (w.ballArc && Array.isArray(w.ballArc.trail)) ? w.ballArc.trail : [];
      if (!pts.length) return false;
      const last = pts[pts.length - 1];
      return (last && typeof last.y === 'number') ? (last.y > (rimBottom + margin)) : false;
    });
    expect(belowOK).toBeTruthy();

    // 4) summary emitted (and server posts)
    const summaryOk = await page.waitForFunction(() => !!(window as any).__lastSummary || ((window as any).shotLog?.length||0) > 0, null, { timeout: 30_000 })
      .then(() => true).catch(() => false);
    expect(summaryOk).toBeTruthy();

    // Give a moment for POSTs to be observed
    await page.waitForTimeout(500);
    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(uploads.length).toBeGreaterThanOrEqual(1);
  });
});

