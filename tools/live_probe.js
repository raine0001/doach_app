#!/usr/bin/env node
/*
 * Launch Doach dev server and open the live camera view with release probes enabled.
 * - Starts python app.py on 127.0.0.1:5001 (or PORT env)
 * - Opens default browser to /?probe=release&__live=1
 * - Pass ?release=mm:ss or ?frame=N via CLI, e.g.
 *     npx --yes doach-app live:probe --release=00:08:33
 */
const { spawn } = require('child_process');
const os = require('os');

function pickPython() {
  // Prefer active PATH python (conda/venv) on Windows to match installed deps
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  return candidates[0];
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

function parseArgs() {
  const out = { release: null, frame: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--release=')) out.release = a.split('=')[1];
    else if (a.startsWith('--frame=')) out.frame = a.split('=')[1];
  }
  return out;
}

(async function main(){
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || '5001';
  const py = pickPython();
  const pyArgs = ['app.py'];
  const env = { ...process.env };
  env.HOST = host; env.PORT = String(port);

  console.log(`[live:probe] starting server: ${py} ${pyArgs.join(' ')} on http://${host}:${port}`);
  const srv = spawn(py, pyArgs, { stdio: 'inherit', env });

  srv.on('error', (e) => {
    console.error('[live:probe] failed to start server:', e.message || e);
  });

  // Build the URL with probe flags
  const q = new URLSearchParams();
  q.set('probe', 'release');
  q.set('__live', '1');
  q.set('trace', '1');
  const { release, frame } = parseArgs();
  if (release) q.set('release', release);
  if (frame) q.set('frame', String(frame));
  const url = `http://${host}:${port}/?${q.toString()}`;

  // Wait a moment then open browser
  setTimeout(() => {
    console.log('[live:probe] opening', url);
    openBrowser(url);
  }, 1200);
})();
