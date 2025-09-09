import { test, expect, Page } from '@playwright/test';
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5001/';

async function patchRVFC(page: Page) {
  await page.addInitScript(() => {
    const proto: any = (window as any).HTMLVideoElement?.prototype;
    if (!proto || proto.__rvfcPatchedForCore) return;
    const timers = new WeakMap<HTMLVideoElement, Map<number, number>>();
    proto.requestVideoFrameCallback = function(cb: any) {
      const v = this as HTMLVideoElement; const id = Math.floor(Math.random()*1e9);
      const t = setTimeout(() => cb(performance.now(), { mediaTime: v.currentTime }), 16);
      if (!timers.get(v)) timers.set(v, new Map()); timers.get(v)!.set(id, t); return id;
    };
    const origCancel = proto.cancelVideoFrameCallback;
    proto.cancelVideoFrameCallback = function(id: number){ const m = timers.get(this as HTMLVideoElement); if (m?.has(id)) { clearTimeout(m.get(id)!); m.delete(id); } else try{ origCancel?.call(this,id);}catch{} };
    Object.defineProperty(proto, '__rvfcPatchedForCore', { value: true });
  });
}

test('core: release → prox enter → end', async ({ page }) => {
  await patchRVFC(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector('video#videoPlayer');
  await page.waitForSelector('#overlay, #videoCanvas');

  // Bind event counters
  await page.evaluate(() => {
    (window as any).__ev = { release: 0, end: 0, summary: 0 };
    window.addEventListener('shot:release', () => (window as any).__ev.release++);
    window.addEventListener('shot:end',     () => (window as any).__ev.end++);
    window.addEventListener('shot:summary', () => (window as any).__ev.summary++);
  });

  // Load a server-hosted clip and set canvas size
  await page.evaluate(async () => {
    const v = document.getElementById('videoPlayer') as HTMLVideoElement;
    v.muted = true; (v as any).playsInline = true; v.preload = 'auto';
    try {
      const res = await fetch('/api/videos', { cache: 'no-store' });
      const list = await res.json();
      const first = Array.isArray(list) ? list[0] : (list?.videos?.[0] || null);
      const url = (typeof first === 'string') ? first : (first?.url || first?.path || '/static/videos/sample.mp4');
      v.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    } catch {
      v.src = '/static/videos/sample.mp4?t=' + Date.now();
    }
    v.load();
    const once = (el: EventTarget, type: string, ms: number) => new Promise((res, rej)=>{ const to=setTimeout(()=>rej(new Error(type+' timeout')),ms); const fn=(ev:any)=>{clearTimeout(to); (el as any).removeEventListener(type, fn, { once:true } as any); res(ev);}; (el as any).addEventListener(type, fn, { once:true });});
    try { await (once(v,'loadedmetadata', 20000) as any); } catch {}
    try { await (once(v,'canplay', 15000) as any); } catch {}
    const cv = (document.getElementById('overlay') || document.getElementById('videoCanvas')) as HTMLCanvasElement;
    if (cv && (!cv.width || !cv.height)) { cv.width = v.videoWidth || 1280; cv.height = v.videoHeight || 720; }
    (window as any).__videoFPS = 30;
  });

  // Seed hoop lock from first detected hoop if available, else set a gentle bias
  await page.evaluate(() => {
    (window as any).__forceServerDetect = true;
    (window as any).BALL_MAX_STEP = 60;
    // if tests shim provided one, keep it; otherwise set a bias near top-right
    if (!(window as any).__lockedHoopBox) {
      (window as any).__lockedHoopBox = { cx: 1216, cy: 244, w: 140, h: 100 };
    }
    // Relax gates for test
    (window as any).RELEASE_DELAY_FRAMES = 1;
    (window as any).REL_POSE_STREAK = 1;
    (window as any).REL_UPWARD_MIN_FRAMES = 1;
    (window as any).REL_HAND_DIST_PX = 120;
    (window as any).EXIT_LINGER_FRAMES = 8;
    (window as any).EXIT_BELOW_MARGIN = 12;
    (window as any).proxX = 200; (window as any).proxYAbove = 170; (window as any).proxYBelow = 100;
    try { (window as any).ensureOverlayCss?.(); (window as any).lockOverlayToVideo?.(); } catch {}
  });

  // Gesture + play + start analyzer
  const box = await page.locator('#overlay, #videoCanvas').boundingBox();
  if (box) await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
  await page.evaluate(async () => { const v = document.getElementById('videoPlayer') as HTMLVideoElement; try { await v.play(); } catch {} });
  await page.evaluate(() => { const v=document.getElementById('videoPlayer') as HTMLVideoElement; const c=(document.getElementById('overlay')||document.getElementById('videoCanvas')) as HTMLCanvasElement; (window as any).analyzeVideoFrameByFrame?.(v,c); });

  // If hoop is not locked yet, wait for detection then lock to nearest hoop
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    try {
      if (!(window as any).__lockedHoopBox) {
        const hoops = (window as any).lastDetectedFrame?.objects?.filter((o:any)=>o.label==='hoop'&&Array.isArray(o.box))||[];
        if (hoops.length){
          const [x1,y1,x2,y2] = hoops[0].box; const cx=(x1+x2)/2, cy=(y1+y2)/2; (window as any).__lockedHoopBox = { cx, cy, w: x2-x1, h: y2-y1 };
        }
      }
    } catch {}
  });

  // Wait for release
  const released = await page.waitForFunction(() => !!((window as any).__ev?.release || (window as any).ballState?.releaseFrame != null), null, { timeout: 15000 }).then(()=>true).catch(()=>false);
  expect(released).toBeTruthy();

  // Wait for prox enter/exit stamps
  const entered = await page.waitForFunction(() => Number.isFinite((window as any).ballState?.proxEnterFrame), null, { timeout: 8000 }).then(()=>true).catch(()=>false);
  expect(entered).toBeTruthy();

  // Wait for end/summary
  const ended = await page.waitForFunction(() => !!((window as any).__ev?.end || (window as any).__ev?.summary || Number.isFinite((window as any).ballState?.proxExitFrame)), null, { timeout: 10000 }).then(()=>true).catch(()=>false);
  expect(ended).toBeTruthy();
});
