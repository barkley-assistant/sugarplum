"""Per-capture pixel diff between the before/ and after/ columns (#119).

Also reports, for every capture, the diff bounding box — which for this fix is
the formerly-empty thumbnail slot on each no-image row.
"""
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent
rows = []
for after in sorted((ROOT / "after").glob("*.png")):
    before = ROOT / "before" / after.name
    a = Image.open(after).convert("RGB")
    b = Image.open(before).convert("RGB")
    if a.size != b.size:
        rows.append((after.name, f"SIZE {b.size} -> {a.size}", None))
        continue
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    changed = sum(1 for px in diff.getdata() if px != (0, 0, 0))
    rows.append((after.name, changed, bbox))

lines = ["capture\tdiffering_pixels\tbbox (before vs after)"]
for name, changed, bbox in rows:
    lines.append(f"{name}\t{changed}\t{bbox}")
out = "\n".join(lines) + "\n"
(ROOT / "diff-matrix.txt").write_text(out)
print(out)

by_surface = {}
for name, changed, bbox in rows:
    surface = name.rsplit("-", 2)[0]
    by_surface.setdefault(surface, []).append((name, changed))

print("=== summary ===")
for surface, entries in sorted(by_surface.items()):
    changed = [c for _, c in entries if c]
    print(
        f"{surface}: {len(entries)} captures, {len(changed)} differ; "
        f"changed px {min(c for _, c in entries)}..{max(c for _, c in entries)}"
    )

(ROOT / "measurements-before.json").write_text((ROOT / "before" / "measurements.json").read_text())
(ROOT / "measurements-after.json").write_text((ROOT / "after" / "measurements.json").read_text())
print("wrote measurements-before.json / measurements-after.json")
