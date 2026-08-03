#!/usr/bin/env python3
"""Extract /client JS from web_app.py and run node --check."""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
text = (ROOT / "talk_module" / "web_app.py").read_text(encoding="utf-8")
chunk = text.split('CLIENT_TEMPLATE = """', 1)[1].split('"""\n\n# Local page', 1)[0]
scripts = re.findall(r"<script>(.*?)</script>", chunk, re.S)
if not scripts:
    print("No script blocks found", file=sys.stderr)
    sys.exit(1)
js_path = ROOT / "_tmp_client.js"
js_path.write_text(scripts[-1], encoding="utf-8")
print(f"Wrote {js_path} ({len(scripts[-1])} chars, {scripts[-1].count(chr(10)) + 1} lines)")
try:
    subprocess.run(["node", "--check", str(js_path)], check=True)
    print("OK: JavaScript syntax valid")
except FileNotFoundError:
    print("node not found; skipped syntax check")
except subprocess.CalledProcessError as e:
    sys.exit(e.returncode)
