import re
from pathlib import Path

js = Path("_tmp_client.js").read_text(encoding="utf-8")
lines = js.splitlines()

# onclick handlers closed with }); instead of };
bad = []
for i, line in enumerate(lines, 1):
    if re.search(r"\.onclick\s*=\s*function\s*\(", line):
        # find closing - scan forward up to 80 lines
        depth = 0
        started = False
        for j in range(i - 1, min(len(lines), i + 79)):
            l = lines[j]
            if "function" in l and "onclick" in l:
                started = True
            if not started:
                continue
            depth += l.count("{") - l.count("}")
            if depth == 0 and j > i - 1:
                closing = lines[j].strip()
                if closing == "});":
                    bad.append((i, j + 1, closing))
                break

print("bad onclick closings:", len(bad))
for a, b, c in bad:
    print(f"  opens {a}, closes {b}: {c}")

# lines around browser-reported 2942 in rendered page ~= template offset
# print context near line 2942 of full client page - approximate script offset
for n in (2938, 2939, 2940, 2941, 2942, 2943, 2944):
    if 0 <= n - 1 < len(lines):
        print(f"js {n}: {lines[n-1]!r}")
