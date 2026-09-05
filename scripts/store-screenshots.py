#!/usr/bin/env python3
"""Crop public/screenshots into the 1280x800 the Chrome Web Store requires.

The store accepts only 1280x800 or 640x400 and wants full bleed, so this crops
rather than letterboxes. Requires Pillow, which is a local tool only and is
deliberately not a project dependency.
"""
import pathlib
import sys

from PIL import Image

WIDTH, HEIGHT = 1280, 800
ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "public" / "screenshots"
TARGET = ROOT / "store-assets"


def main() -> int:
    if not SOURCE.is_dir():
        print(f"no screenshots at {SOURCE}", file=sys.stderr)
        return 1

    TARGET.mkdir(exist_ok=True)
    images = sorted(SOURCE.glob("*.png"))
    for path in images:
        image = Image.open(path).convert("RGB")
        width, height = image.size
        target_ratio = WIDTH / HEIGHT
        if width / height > target_ratio:
            # Trim the left edge, which is page chrome rather than panel content.
            cropped_width = int(height * target_ratio)
            image = image.crop((width - cropped_width, 0, width, height))
        else:
            cropped_height = int(width / target_ratio)
            top = (height - cropped_height) // 2
            image = image.crop((0, top, width, top + cropped_height))
        image = image.resize((WIDTH, HEIGHT), Image.LANCZOS)
        out = TARGET / path.name
        image.save(out, optimize=True)
        print(f"{path.name}: {width}x{height} -> {WIDTH}x{HEIGHT} ({out.stat().st_size // 1024} KB)")

    print(f"{len(images)} screenshot(s) written to store-assets/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
