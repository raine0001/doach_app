const { chromium } = require('playwright');

(async () => {
  const url = 'http://127.0.0.1:5001/';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Give modules a moment
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({
    appJs: !!window.__appJsLoaded,
    analyzerModule: !!window.__analyzerModuleLoaded,
    legacyFn: typeof window.legacyAnalyzeVideoFrameByFrame === 'function',
    realFn: typeof window.__realAnalyzeVideoFrameByFrame === 'function',
    analyzeFn: typeof window.analyzeVideoFrameByFrame === 'function',
    bootLog: (window.__bootLog || []).slice(-5),
  }));
  console.log(info);
  await browser.close();
})().catch((e) => { console.error('check_boot failed:', e); process.exit(1); });

