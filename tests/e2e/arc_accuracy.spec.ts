// tests/e2e/arc_accuracy.spec.ts — targeted checks for arc rendering + shot accuracy
import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test.setTimeout(120_000);

const BASE_URL  = 'http://127.0.0.1:5001/';
const CLIP_PATH = process.env.DOACH_TEST_CLIP
  ? process.env.DOACH_TEST_CLIP
  : 'C:/Users/dave/Desktop/Doach/content/3shot_trim.mp4';

// Tune for this clip (1280x720 canvas coords)
const HOOP_CANVAS = { x: 1216, y: 244, baseW: 1280, baseH: 720 };

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

async function hardForceHoopLock(page: Page, hoop = HOOP_CANVAS) {
  await page.evaluate(({ p }) => {
    const w: any = window;
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement | null;
    if (!cv) throw new Error('[e2e] canvas not found');
    const r  = cv.getBoundingClientRect();
    const cw = cv.width || r.width;
    const ch = cv.height || r.height;
    const cx = p.x * (cw / p.baseW);
    const cy = p.y * (ch / p.baseH);
    w.__lockedHoopBox = { cx, cy, x: cx - 70, y: cy - 50, w: 140, h: 100 };
    w.getLockedHoopBox = () => w.__lockedHoopBox;
    w.__hoopConfirmed = true;
  }, { p: hoop });

  await page.waitForFunction(() => {
    const H = (window as any).getLockedHoopBox?.();
    const cx = H?.cx ?? H?.x; const cy = H?.cy ?? H?.y;
    return Number.isFinite(cx) && Number.isFinite(cy);
  }, null, { timeout: 10_000 });
}

async function startFrames(page: Page) {
  // Drive frames even if autoplay is blocked (RVFC polyfill already in app)
  const ok = await page.evaluate(async () => {
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    try { v.muted = true; v.setAttribute('autoplay',''); await v.play(); if (!v.paused) return true; } catch {}
    (window as any).__e2eStepper && clearInterval((window as any).__e2eStepper);
    (window as any).__e2eStepper = setInterval(()=>{ try { const next=(v.currentTime||0)+1/60; if (v.duration) v.currentTime=Math.min(next, v.duration-0.001);} catch{} }, 16);
    return false;
  });
  const framesOk = await page.waitForFunction(() => Number.isFinite((window as any).lastDetectedFrame?.__frameIdx) && (window as any).lastDetectedFrame.__frameIdx >= 2, null, { timeout: 12_000 }).then(()=>true).catch(()=>false);
  if (!framesOk) throw new Error('frames did not advance');
}

async function prepare(page: Page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video#videoPlayer');
  await page.waitForSelector('#overlay, #videoCanvas');
  await page.evaluate(async () => {
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    v.muted = true; (v as any).playsInline = true; v.preload = 'auto';
    v.src = '/__test_clip__?t=' + Date.now();
    v.load();
    try { (window as any).ensureOverlayCss?.(); (window as any).lockOverlayToVideo?.(); } catch {}
    await new Promise((res, rej)=>{ const to=setTimeout(()=>rej(new Error('canplay timeout')), 30_000); const fn=()=>{clearTimeout(to);res(null)}; v.addEventListener('canplay', fn, { once: true }); });
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement | null;
    if (cv && (!cv.width || !cv.height)) { cv.width = v.videoWidth || 1280; cv.height = v.videoHeight || 720; }
    // Favor stable detection for tests
    (window as any).__forceServerDetect = true; (window as any).DETECT_ROI_ONLY = true; (window as any).__ROI_DETECT_ALWAYS = true;
    (window as any).REL_HAND_DIST_PX = 120; (window as any).REL_POSE_STREAK = 1; (window as any).REL_UPWARD_MIN_FRAMES = 1; (window as any).RELEASE_DELAY_FRAMES = 1;
  });
  await hardForceHoopLock(page);
  await page.evaluate(() => {
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    const c = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
    (window as any).analyzeVideoFrameByFrame?.(v, c);
  });
  await startFrames(page);
}

async function assertArcRenderedAndFrozen(page: Page, { minPixels = 700, stableMs = 400 } = {}) {
  const pixelStats = async () => await page.evaluate(() => {
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
    if (!cv) return { non: 0, hash: 0, w: 0, h: 0 };
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const data = ctx.getImageData(0,0,cv.width,cv.height).data;
    let non = 0, hash = 0 >>> 0; for (let i=0;i<data.length;i+=4){ const a=data[i+3]; if(a>0) non++; const r=data[i],g=data[i+1],b=data[i+2]; hash=(hash+r+(g<<1)+(b<<2)+a)>>>0; }
    return { non, hash, w: cv.width, h: cv.height };
  });
  await page.evaluate(() => (window as any).setOverlayMode?.('clean'));
  await page.waitForTimeout(80);
  const a = await pixelStats();
  if (a.non < minPixels) throw new Error(`Arc not rendered: painted=${a.non} (<${minPixels}) on ${a.w}x${a.h}`);
  await page.waitForTimeout(stableMs);
  const b = await pixelStats();
  if (a.non !== b.non || a.hash !== b.hash) throw new Error(`Arc not frozen: overlay changed (non ${a.non}->${b.non}, hash ${a.hash}->${b.hash})`);
}

test('arc smoothness + shot accuracy for known 3-shot clip', async ({ page }) => {
  await routeTestClip(page);
  await prepare(page);

  const EXPECTED: Array<boolean> = [true, false, true];

  for (let i = 0; i < 3; i++) {
    // Wait core gates
    const gotRelease = await page.waitForFunction(() => Number.isFinite((window as any).ballState?.releaseFrame) || ((window as any).__gate?.release > 0), null, { timeout: 12_000 }).then(()=>true).catch(()=>false);
    expect(gotRelease).toBeTruthy();

    const gotEnter = await page.waitForFunction(() => Number.isFinite((window as any).ballState?.proxEnterFrame), null, { timeout: 8_000 }).then(()=>true).catch(()=>false);
    expect(gotEnter).toBeTruthy();

    const gotEnd = await page.waitForFunction(() => Number.isFinite((window as any).ballState?.proxExitFrame) || ((window as any).__gate?.summary > 0), null, { timeout: 12_000 }).then(()=>true).catch(()=>false);
    expect(gotEnd).toBeTruthy();

    // Arc should be painted and frozen post-summary
    await assertArcRenderedAndFrozen(page, { minPixels: 700, stableMs: 400 });

    // Accuracy: summary.made must match EXPECTED[i]
    const summary: any = await page.evaluate(() => (window as any).__lastSummary || (window as any).shotLog?.at?.(-1) || null);
    expect(summary && typeof summary.made === 'boolean').toBeTruthy();
    expect(summary.made).toBe(EXPECTED[i]);

    // Prep next shot: seek a bit ahead to next play and re-arm analyzer
    await page.evaluate(() => {
      const v = document.getElementById('videoPlayer') as HTMLVideoElement;
      try { v.play(); } catch {}
      try { (window as any).stopFrameAnalysis?.(); } catch {}
      try { (window as any).analyzeVideoFrameByFrame?.(v, (document.getElementById('overlay') as HTMLCanvasElement)); } catch {}
      (window as any).__lastSummary = null;
    });
  }
});

