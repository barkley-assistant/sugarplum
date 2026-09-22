"""How much of the page above the first row changed between the two columns?"""
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent
for after in sorted((ROOT / "after").glob("*.png")):
    a = Image.open(after).convert("RGB")
    b = Image.open(ROOT / "before" / after.name).convert("RGB")
    top = ImageChops.difference(a.crop((0, 0, a.width, 170)), b.crop((0, 0, b.width, 170)))
    changed = sum(1 for px in top.getdata() if px != (0, 0, 0))
    print(f"{after.name}\tabove-170px-changed={changed}\tbbox={top.getbbox()}")
