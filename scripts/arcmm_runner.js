#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node scripts/arcmm_runner.js <clipPath> <outputDir> <shotIdx> [--base-url=http://127.0.0.1:5000]');
    process.exit(1);
  }

  const extraArgs = args.filter(arg => arg.startsWith('--'));
  const positional = args.filter(arg => !arg.startsWith('--'));
  const [clipPathArg, outputDirArg, idxArg] = positional;

  const clipPath = path.resolve(clipPathArg);
  const outputDir = path.resolve(outputDirArg);
  const shotIdx = Number(idxArg);

  if (!Number.isFinite(shotIdx)) {
    console.error(`Invalid shot index: ${idxArg}`);
    process.exit(1);
  }

  if (!fs.existsSync(clipPath)) {
    console.error(`Clip not found: ${clipPath}`);
    process.exit(1);
  }

  await fsp.mkdir(outputDir, { recursive: true });

  const opts = Object.fromEntries(extraArgs.map(arg => {
    const [key, ...rest] = arg.replace(/^-+/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }));

  const rawEnvBase =
    opts['base-url'] ||
    process.env.ARCMM_BASE_URL ||
    process.env.ARCMM_SERVER_URL ||
    'http://127.0.0.1:5000';

  const expandedEnvBase = rawEnvBase
    .replace(/\$\{PORT\}/g, process.env.PORT || '5000')
    .replace(/\$PORT/g, process.env.PORT || '5000');

  const baseUrl = expandedEnvBase.replace(/\/$/, '');
  const pagePath = process.env.ARCMM_RUNNER_PAGE || '/static/arc_mm/arc_mm.html';
  const timeoutMs = Number(process.env.ARCMM_RUNNER_TIMEOUT || opts['timeout-ms'] || 120000);
  const headlessEnv = (process.env.ARCMM_HEADLESS || '').toLowerCase();
  const headless = opts['headed']
    ? false
    : !(headlessEnv === '0' || headlessEnv === 'false' || headlessEnv === 'no');

  const projectRoot = process.cwd();
  const normalizedClip = path.normalize(clipPath);
  const relClip = path.relative(projectRoot, normalizedClip).replace(/\\/g, '/');

  let clipUrl = null;
  const sessionsMatch = relClip.match(/^sessions\/([^/]+)\/(.+)$/i);
  if (sessionsMatch) {
    clipUrl = `${baseUrl}/sessions/${sessionsMatch[1]}/${sessionsMatch[2]}`;
  } else {
    clipUrl = new URL(`file://${normalizedClip}`).toString();
  }

  const shotId = String(shotIdx);
  const outBasename = `shot-${shotId}`;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('pageerror', (err) => {
    console.error(`[arcmm-runner] page error: ${err?.message || err}`);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    console.error(`[arcmm][console] ${text}`);
  });

  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const timeoutHandle = setTimeout(() => {
    rejectResult(new Error(`timed out after ${timeoutMs} ms waiting for arcmm result`));
  }, timeoutMs);

  await page.exposeBinding('arcmmRunnerReport', (_, detail) => {
    clearTimeout(timeoutHandle);
    resolveResult(detail || {});
  });

  await page.addInitScript(({ shot }) => {
    window.ARCMM_HEADLESS = true;
    window.arcmmRunner = window.arcmmRunner || {};
    window.arcmmRunner.autoStart = true;
    window.arcmmRunner.mode = 'single';
    window.arcmmRunner.forceFullRun = true;
    window.arcmmRunner.shots = [shot];
  }, {
    shot: {
      id: shotId,
      name: path.basename(clipPath),
      url: clipUrl,
      outBasename: `shot-${shotId}`,
    },
  });

  await page.addInitScript(() => {
    window.addEventListener('arcmm:result', async (event) => {
      try {
        const detail = event?.detail || {};
        const overlay = detail.overlay || {};
        let bytes = null;
        if (overlay.blob && typeof overlay.blob.arrayBuffer === 'function') {
          const buf = await overlay.blob.arrayBuffer();
          bytes = Array.from(new Uint8Array(buf));
        }
        const payload = {
          id: detail.id || null,
          outBasename: detail.outBasename || null,
          summary: detail.summary || null,
          hoop: detail.hoop || null,
          proxTail: detail.proxTail || null,
          trail: detail.trail || null,
          arcTrailFrozen: detail.arcTrailFrozen || null,
          overlay: {
            name: overlay.name || null,
            mime: overlay.mime || null,
            url: overlay.url || null,
            bytes,
          },
        };
        await window.arcmmRunnerReport(payload);
      } catch (err) {
        console.error('[arcmm-runner] failed to forward result', err);
      }
    }, { once: true });
  });

  try {
    await page.goto(`${baseUrl}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => {
      return !!(window.arcmmRunner && window.arcmmRunner.ready);
    }, { timeout: timeoutMs });

    const result = await resultPromise;

    const summaryPath = path.join(outputDir, `${outBasename}.summary.json`);
    const overlayName = (result.overlay && result.overlay.name) || `${outBasename}.results.webm`;
    const overlayPath = path.join(outputDir, overlayName);

    if (result.summary) {
      await fsp.writeFile(summaryPath, JSON.stringify(result.summary, null, 2), 'utf-8');
    }

    if (result.overlay && Array.isArray(result.overlay.bytes) && result.overlay.bytes.length) {
      const bytes = Buffer.from(result.overlay.bytes);
      await fsp.writeFile(overlayPath, bytes);
    }

    console.log(JSON.stringify({
      ok: true,
      shotId,
      summaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
      overlayPath: (result.overlay && Array.isArray(result.overlay.bytes) && result.overlay.bytes.length) ? overlayPath : null,
    }));
  } catch (err) {
    console.error(`[arcmm-runner] failed: ${err?.message || err}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[arcmm-runner] unexpected error: ${err?.message || err}`);
  process.exit(1);
});
