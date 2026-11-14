"""Run serial visual captures under one heavy token."""
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent
files = [("review.html", "review-mobile.png", 390), ("review.html", "review-320.png", 320)]
for state in ["incoming", "acknowledged", "reconnecting", "unreachable", "revoked", "multiple"]:
    files += [("state-" + state + ".html", state + "-desktop.png", 1280), ("state-" + state + ".html", state + "-mobile.png", 390)]
files += [("direction-b.html", "arah-b-alert-desktop.png", 1280), ("direction-b.html", "arah-b-alert-mobile.png", 390)]
log = []
for source, output, width in files:
    result = subprocess.run(["ghostex", "visual", "check", str(root / source), "--width", str(width), "--out", str(root / output)], text=True, capture_output=True)
    entry = source + " @ " + str(width) + "\n" + result.stdout + result.stderr
    print(entry, flush=True)
    log.append(entry)
    if result.returncode:
        (root / "visual-check.txt").write_text("\n".join(log))
        raise SystemExit(result.returncode)
(root / "visual-check.txt").write_text("\n".join(log))
