#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const fsPromises = fs.promises;
async function ensureDir(dirPath) {
  if (fsPromises && typeof fsPromises.mkdir === 'function') {
    try {
      await fsPromises.mkdir(dirPath, { recursive: true });
      return;
    } catch (err) {
      if (err && err.code === 'EEXIST') return;
      if (err && err.code !== 'ERR_INVALID_OPT_VALUE') throw err;
      // fall through to manual recursion when recursive option unsupported
    }
  }
  return new Promise((resolve, reject) => {
    fs.stat(dirPath, (err, stats) => {
      if (!err && stats.isDirectory()) return resolve();
      if (err && err.code !== 'ENOENT') return reject(err);
      const parent = path.dirname(dirPath);
      if (!parent || parent === dirPath) {
        fs.mkdir(dirPath, (mkErr) => {
          if (mkErr && mkErr.code !== 'EEXIST') reject(mkErr);
          else resolve();
        });
        return;
      }
      ensureDir(parent)
        .then(() => {
          fs.mkdir(dirPath, (mkErr) => {
            if (mkErr && mkErr.code !== 'EEXIST') reject(mkErr);
            else resolve();
          });
        })
        .catch(reject);
    });
  });
}

async function writeFile(filePath, data, options) {
  if (fsPromises && typeof fsPromises.writeFile === 'function') {
    return fsPromises.writeFile(filePath, data, options);
  }
  return new Promise((resolve, reject) => {
    fs.writeFile(filePath, data, options, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error('Usage: node scripts/arcmm_runner.js <clipPath> <outputDir> <shotIdx> [--base-url=http://127.0.0.1:${PORT}]');
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

  await ensureDir(outputDir);

  const opts = Object.fromEntries(extraArgs.map(arg => {
    const [key, ...rest] = arg.replace(/^-+/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }));

  const rawEnvBase =
    opts['base-url'] ||
    process.env.ARCMM_BASE_URL ||
    process.env.ARCMM_SERVER_URL ||
    'http://127.0.0.1:${PORT}';

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
    let message = '';
    if (err) {
      if (err.stack) message = err.stack;
      else if (err.message) message = err.message;
      else message = String(err);
    } else {
      message = '(unknown error)';
    }
    console.error(`[arcmm-runner] page error: ${message}`);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    console.error(`[arcmm][console] ${text}`);
  });
  page.on('requestfailed', (request) => {
    try {
      const failure = request.failure();
      console.error(
        `[arcmm-runner] request failed ${request.method()} ${request.url()} :: ${failure ? failure.errorText : 'unknown reason'}`
      );
    } catch (err) {
      console.error('[arcmm-runner] requestfailed handler error', err);
    }
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
        const detail = (event && event.detail) || {};
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
    console.error(`[arcmm-runner] opening ${baseUrl}${pagePath} (clip=${clipUrl})`);
    const response = await page.goto(`${baseUrl}${pagePath}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response) {
      console.error('[arcmm-runner] page.goto returned no response (possible navigation failure)');
    } else if (!response.ok()) {
      console.error(`[arcmm-runner] non-OK response: ${response.status()} ${response.statusText()} from ${response.url()}`);
    }
    await page.waitForFunction(() => {
      return !!(window.arcmmRunner && window.arcmmRunner.ready);
    }, { timeout: timeoutMs });

    const result = await resultPromise;

    const summaryPath = path.join(outputDir, `${outBasename}.summary.json`);
    const overlayName = (result.overlay && result.overlay.name) || `${outBasename}.results.webm`;
    const overlayPath = path.join(outputDir, overlayName);

    if (result.summary) {
      await writeFile(summaryPath, JSON.stringify(result.summary, null, 2), 'utf-8');
    }

    if (result.overlay && Array.isArray(result.overlay.bytes) && result.overlay.bytes.length) {
      const bytes = Buffer.from(result.overlay.bytes);
      await writeFile(overlayPath, bytes);
    }

    console.log(JSON.stringify({
      ok: true,
      shotId,
      summaryPath: fs.existsSync(summaryPath) ? summaryPath : null,
      overlayPath: (result.overlay && Array.isArray(result.overlay.bytes) && result.overlay.bytes.length) ? overlayPath : null,
    }));
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    console.error(`[arcmm-runner] failed: ${msg}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
    await browser.close();
  }
}

main().catch((err) => {
  const msg = err && err.message ? err.message : err;
  console.error(`[arcmm-runner] unexpected error: ${msg}`);
  process.exit(1);
});
