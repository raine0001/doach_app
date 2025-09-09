const { chromium } = require('playwright');
(async () => {
  const url = 'http://127.0.0.1:5001/';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const v = document.getElementById('videoPlayer');
    const c = document.getElementById('overlay');
    (window).analyzeVideoFrameByFrame?.(v, c);
  });
  await page.waitForTimeout(1800);
  const info = await page.evaluate(() => ({
    appJs: !!window.__appJsLoaded,
    analyzerModule: !!window.__analyzerModuleLoaded,
    legacyFn: typeof window.legacyAnalyzeVideoFrameByFrame === 'function',
    realFn: typeof window.__realAnalyzeVideoFrameByFrame === 'function',
    analyzeFn: typeof window.analyzeVideoFrameByFrame === 'function',
    analyzerActive: !!window.__analyzerActive,
    lastFrame: window.lastDetectedFrame?.__frameIdx ?? null,
    bootLog: (window.__bootLog || []),
  }));
  console.log(info);
  await browser.close();
})().catch((e) => { console.error('check_boot invoke failed:', e); process.exit(1); });
