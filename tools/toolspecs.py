# tools/toolspecs.py
import os
import shutil
import subprocess
import time
import signal
from pathlib import Path

ART = Path("artifacts")
ART.mkdir(exist_ok=True)

def _find_playwright_cmds():
    """
    Return a list of candidate commands to launch Playwright CLI.
    Tries, in order:
      - npx.cmd playwright   (Windows)
      - npx playwright       (Unix / when PATH has npx)
      - node_modules/.bin/playwright(.cmd)
    """
    cmds = []
    if os.name == "nt":
        npx_cmd = shutil.which("npx.cmd") or r"C:\Program Files\nodejs\npx.cmd"
        if npx_cmd and Path(npx_cmd).exists():
            cmds.append([npx_cmd, "playwright"])
    npx_generic = shutil.which("npx")
    if npx_generic:
        cmds.append([npx_generic, "playwright"])
    local_bin = Path(
        "node_modules/.bin/playwright.cmd" if os.name == "nt"
        else "node_modules/.bin/playwright"
    )
    if local_bin.exists():
        cmds.append([str(local_bin)])
    return cmds

def _ensure_playwright():
    # Ensure @playwright/test package exists
    if not Path("node_modules/@playwright/test").exists():
        npm = shutil.which("npm") or r"C:\Program Files\nodejs\npm.cmd"
        if not npm or not Path(npm).exists():
            raise RuntimeError("npm not found. Install Node.js LTS and reopen your terminal.")
        subprocess.run([npm, "i", "-D", "@playwright/test"], check=True)

    # Ensure browsers are installed (best-effort)
    for cmd in _find_playwright_cmds():
        try:
            subprocess.run([*cmd, "install"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except FileNotFoundError:
            continue
    raise RuntimeError("Playwright CLI not found (npx or local bin). Put Node.js on PATH or use node_modules/.bin/playwright.")

def _wb(path: Path):
    return path.open("wb")

def run_playwright(timeout_sec: int = 360) -> bool:
    """
    Launch 'playwright test' and stream stdout/stderr to artifacts/stdout.txt, stderr.txt
    Returns True if tests passed (exit code 0).
    """
    _ensure_playwright()
    env = os.environ.copy()   # propagate DOACH_TEST_CLIP, OPENAI_API_KEY, etc.

    args = ["test", "-c", "playwright.config.ts", "--project", "chrome", "--reporter", "list"]  # just chrome

    proc = None
    for cmd in _find_playwright_cmds():
        try:
            # Binary pipes to avoid Windows decoding errors
            proc = subprocess.Popen(
                [*cmd, *args],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env
            )
            break
        except FileNotFoundError:
            continue

    if proc is None:
        raise FileNotFoundError("Unable to run Playwright (npx/playwright not found).")

    out_path = ART / "stdout.txt"
    err_path = ART / "stderr.txt"

    start = time.time()
    with _wb(out_path) as out_f, _wb(err_path) as err_f:
        # Non-blocking-ish loop that checks both pipes
        while True:
            if proc.poll() is not None:
                # Drain remaining bytes if any
                try:
                    if proc.stdout: out_f.write(proc.stdout.read() or b"")
                    if proc.stderr: err_f.write(proc.stderr.read() or b"")
                except Exception:
                    pass
                break

            # read1() is available on BufferedReader (binary)
            try:
                if proc.stdout:
                    chunk = proc.stdout.read1(4096)
                    if chunk: out_f.write(chunk)
                if proc.stderr:
                    echunk = proc.stderr.read1(4096)
                    if echunk: err_f.write(echunk)
            except Exception:
                pass

            out_f.flush(); err_f.flush()

            # Timeout guard
            if time.time() - start > timeout_sec:
                try:
                    if os.name == "nt":
                        proc.send_signal(signal.CTRL_BREAK_EVENT)
                        time.sleep(0.5)
                    proc.terminate()
                    time.sleep(0.5)
                    proc.kill()
                except Exception:
                    pass
                err_f.write(b"\n[tools] Playwright run timed out\n")
                err_f.flush()
                break

            time.sleep(0.05)

    return proc.returncode == 0

def collect_artifacts():
    data = {"stdout": "", "stderr": ""}
    p = ART / "stdout.txt"
    if p.exists():
        data["stdout"] = p.read_text(encoding="utf-8", errors="ignore")
    p = ART / "stderr.txt"
    if p.exists():
        data["stderr"] = p.read_text(encoding="utf-8", errors="ignore")
    return data

def apply_unified_patch(diffs):
    import tempfile
    changed = False
    for d in diffs or []:
        diff_text = (d.get("unifiedDiff") or "").strip()
        if not diff_text:
            continue
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".diff", encoding="utf-8") as f:
            f.write(diff_text)
            name = f.name
        try:
            subprocess.run(["git", "apply", "--unidiff-zero", name], check=True)
            changed = True
        except subprocess.CalledProcessError as e:
            print("[patch] failed:", d.get("path"), e)
        finally:
            try: os.unlink(name)
            except: pass
    return changed

def git_commit_branch(msg):
    subprocess.run(["git", "add", "-A"], check=True)
    subprocess.run(["git", "commit", "-m", msg], check=True)
