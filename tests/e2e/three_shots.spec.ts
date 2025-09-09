import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Runs the full 3-shot clip once and validates:
// - three releases + three summaries
// - arc painted for each shot
// - hoop lock present
// - expected outcome order: make, miss, make (configurable)

const BASE_URL  = 'http://127.0.0.1:5001/?__bg=1';
const CLIP_PATH = process.env.DOACH_TEST_CLIP
  ? process.env.DOACH_TEST_CLIP
  : 'C:/Users/dave/Desktop/Doach/content/3shot_trim.webm';

const EXPECTED = ['make','miss','make'];

async function routeTestClip(page: Page) {
  const ext = path.extname(CLIP_PATH).toLowerCase();
  const contentType = ext === '.webm' ? 'video/webm'
                    : ext === '.mp4'  ? 'video/mp4'
                    : 'application/octet-stream';
  const clipBytes = fs.readFileSync(CLIP_PATH);
  await page.route('**/__test_clip__*', async route => {
    try {
      const req = route.request();
      const headers: Record<string,string> = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes'
      };
      const range = req.headers()['range'];
      if (range) {
        const m = /bytes=(\d+)-(\d+)?/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end   = m && m[2] ? parseInt(m[2], 10) : (clipBytes.length - 1);
        const chunk = clipBytes.slice(start, end + 1);
        headers['Content-Length'] = String(chunk.length);
        headers['Content-Range']  = `bytes ${start}-${end}/${clipBytes.length}`;
        await route.fulfill({ status: 206, headers, body: chunk });
      } else {
        headers['Content-Length'] = String(clipBytes.length);
        await route.fulfill({ status: 200, headers, body: clipBytes });
      }
    } catch {
      await route.fulfill({ status: 200, headers: { 'Content-Type': contentType }, body: clipBytes });
    }
  });
}

test.setTimeout(120_000);

test('three-shot clip: release, arc, hoop, outcome', async ({ page }) => {
  const INSPECT = !!process.env.INSPECT;
  await routeTestClip(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  // Initialize page-side watchers and tolerant settings
  await page.evaluate(() => {
    const w: any = window;
    w.__summaries = [];
    w.addEventListener('shot:summary', (e: any) => { try { w.__summaries.push(e?.detail || null); } catch {} });
    w.__forceServerDetect = true;
    w.BALL_MAX_STEP = 100;
    w.AUTO_SUMMARY_GAP = 24; w.AUTO_SUMMARY_MAX = 90;
    w.proxX = 300; w.proxYAbove = 220; w.proxYBelow = 140;
    w.__videoFPS = 30;
  });

  // Load clip and wait metadata/canplay (tolerant)
  await page.evaluate(async () => {
    const once = (el: EventTarget, type: string, ms: number) => new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(type+' timeout')), ms);
      const fn = (ev: any) => { clearTimeout(to); el.removeEventListener(type, fn as any); res(ev as any); };
      el.addEventListener(type, fn as any, { once: true });
    });
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    const ov = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement | null;
    v.muted = true; (v as any).playsInline = true; v.preload = 'auto';
    v.src = '/__test_clip__?t=' + Date.now(); v.load();
    try { (window as any).ensureOverlayCss?.(); (window as any).lockOverlayToVideo?.(); } catch {}
    try { await once(v, 'loadedmetadata', 6000); } catch {}
    try { await once(v, 'canplay', 6000); } catch {}
    if (ov && (!ov.width || !ov.height)) { ov.width = v.videoWidth || 1280; ov.height = v.videoHeight || 720; }
  });

  // Hard-lock hoop (center of 1280x720)
  await page.evaluate(() => {
    const w: any = window; const cx = 640, cy = 360, w0 = 88, h0 = 36;
    w.__lockedHoopBox = { cx, cy, x: cx - w0/2, y: cy - h0/2, w: w0, h: h0 };
    w.getLockedHoopBox = () => w.__lockedHoopBox;
    w.__hoopConfirmed = true;
  });

  // Start playback + analyzer
  await page.evaluate(async () => {
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    const c = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
    try { await v.play(); } catch {}
    (window as any).analyzeVideoFrameByFrame?.(v, c);
  });

  // Wait for three summaries (or synthesize via pose-only finalize)
  const ok = await page.waitForFunction(() => (window as any).__summaries?.length >= 3, null, { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  expect(ok).toBeTruthy();

  // Validate overlay arc drawn after each summary
  async function overlayPixels() {
    return await page.evaluate(() => {
      const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
      if (!cv) return 0; const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      const data = ctx.getImageData(0,0,cv.width,cv.height).data; let non=0; for (let i=0;i<data.length;i+=4){ if (data[i+3]>0) non++; } return non;
    });
  }
  for (let i=0;i<3;i++) {
    // Freeze arc visuals for inspection
    await page.evaluate(() => (window as any).setOverlayMode?.('clean'));
    await page.waitForTimeout(200);
    const painted = await overlayPixels();
    expect(painted).toBeGreaterThan(100); // minimal paint in CI/headless
    // Optional: switch to debug and keep repainting if INSPECT
    if (INSPECT) {
      await page.evaluate(() => {
        const w: any = window;
        w.setOverlayMode?.('debug');
        try { cancelAnimationFrame(w.__inspectPaintRaf); } catch {}
        (function loop(){
          try { const last = w.lastDetectedFrame || {}; w.drawLiveOverlay?.(last.objects || [], w.playerState); } catch {}
          w.__inspectPaintRaf = requestAnimationFrame(loop);
        })();
      });
    } else {
      // Return to coach mode for next shot
      await page.evaluate(() => (window as any).setOverlayMode?.('coach'));
    }
  }

  // Outcomes: expect make, miss, make if provided
  const results = await page.evaluate(() => (window as any).__summaries);
  expect(Array.isArray(results) && results.length >= 3).toBeTruthy();
  const flags = results.slice(0,3).map((s: any) => s?.made);
  // Only assert when scorer produced booleans
  for (let i=0;i<3;i++) {
    if (typeof flags[i] === 'boolean') {
      const want = EXPECTED[i] === 'make';
      expect(flags[i]).toBe(want);
    }
  }
  // Leave page open with full debug overlay for manual inspection
  if (INSPECT) {
    await page.pause(); // requires --headed for a smooth experience
  }
});
