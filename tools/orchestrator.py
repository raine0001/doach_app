# orchestrator.py
# 1. Terminal 1: your app at http://127.0.0.1:5001
# python app.py   # or flask run / npm run dev

# 2. Terminal 2: Playwright
# npx playwright test --project=chrome -c .\playwright.config.js


import os, json, time
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
from toolspecs import run_playwright, collect_artifacts, apply_unified_patch, git_commit_branch

client = None

def get_openai_client():
    global client

    if client is not None:
        return client

    load_dotenv()  # Ensure .env is loaded

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("❌ OPENAI_API_KEY not set in environment or .env file.")

    client = OpenAI(api_key=api_key)
    return client

MAX_ITERS = int(os.getenv("DOACH_MAX_ITERS", "5"))

def call(prompt_file, payload):
  sys = Path(prompt_file).read_text()
  r = client.chat.completions.create(
    model="gpt-5-thinking",
    messages=[{"role":"system","content":sys},
              {"role":"user","content":json.dumps(payload)}],
    temperature=0)
  return r.choices[0].message.content

def main():
  for i in range(1, MAX_ITERS+1):
    print(f"[loop] iter {i}")
    ok = run_playwright()
    arts = collect_artifacts()
    if ok:
      print("[loop] ✅ green"); break

    runner_out = call("tools/prompts/runner.md", {"artifacts": arts})
    print("[runner]", runner_out)
    try: runner = json.loads(runner_out)
    except: runner = {"summary": runner_out, "hints":[], "suspectedFiles":[]}

    fixer_out = call("tools/prompts/fixer.md", {"runner": runner})
    print("[fixer]", fixer_out)
    try: fixer = json.loads(fixer_out)
    except: break

    if not apply_unified_patch(fixer.get("diffs")):
      print("[loop] no changes applied"); break
    git_commit_branch("Auto-fix: " + (fixer.get("rationale") or "arc/scorer"))
    # re-run next iteration
  else:
    print("[loop] reached iteration limit")

if __name__ == "__main__":
  main()