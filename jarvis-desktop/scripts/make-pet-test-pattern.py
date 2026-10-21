#!/usr/bin/env python3
"""Engineering fixture for the pet renderer: a v2-shaped atlas of flat labelled rectangles.

It is deliberately NOT character art: no eyes, face, limbs or body shapes, and every frame says "TEST PATTERN". It only
exercises geometry, timing, the load check and hit testing. Never copy it into assets/pets/.

Writes tests/fixtures/pet-test-pattern/{spritesheet.png,pet.json}. Requires Python 3 + Pillow.
"""
import hashlib
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'fixtures' / 'pet-test-pattern'
CELL_W, CELL_H, COLS, ROWS = 192, 208, 8, 11
ROWS_SPEC = [
    ('idle', 6), ('running-right', 8), ('running-left', 8), ('waving', 4), ('jumping', 5),
    ('failed', 8), ('waiting', 6), ('running', 6), ('review', 6),
]
COLOURS = ['#4f6bed', '#2f9e8f', '#c47f2c', '#9b59b6', '#d35454', '#7f8c8d', '#e0a526', '#3498db', '#16a085', '#5d6d7e', '#8e44ad']
JUMP_LIFT = [0, 18, 36, 18, 0]


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def frame(draw, row, col, label, lift=0):
    x0, y0 = col * CELL_W, row * CELL_H
    # Rectangle 120x150 standing on the anchor line y=196 (12 px above the cell bottom), centred.
    left, right = x0 + 36, x0 + 156
    bottom = y0 + 196 - lift
    top = bottom - 150
    draw.rounded_rectangle([left, top, right, bottom], radius=14, fill=COLOURS[row], outline='#ffffff', width=3)
    draw.text((left + 10, top + 12), 'TEST', font=font(18), fill='#ffffff')
    draw.text((left + 10, top + 32), 'PATTERN', font=font(18), fill='#ffffff')
    draw.text((left + 10, top + 64), label, font=font(15), fill='#ffffff')
    draw.text((left + 10, bottom - 24), 'not character art', font=font(11), fill='#ffffff')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    img = Image.new('RGBA', (COLS * CELL_W, ROWS * CELL_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for row, (state, frames) in enumerate(ROWS_SPEC):
        for col in range(frames):
            frame(draw, row, col, f'{state} {col}', JUMP_LIFT[col] if state == 'jumping' else 0)
    for i in range(16):
        frame(draw, 9 + i // 8, i % 8, f'look {i * 22.5:05.1f}')
    png = OUT / 'spritesheet.png'
    img.save(png, optimize=True)
    sha = hashlib.sha256(png.read_bytes()).hexdigest()
    manifest = {
        'format': 'desktop-companion/pet-pack@1',
        'id': 'test-pattern',
        'name': 'Test pattern (not character art)',
        'description': 'Flat labelled rectangles for renderer tests. Not a character.',
        'spriteVersion': 2,
        'atlas': 'spritesheet.png',
        'atlasSha256': sha,
        'rendering': 'smooth',
        'anchor': {'x': 96, 'y': 196},
        'review': {'status': 'concept', 'notes': 'Engineering fixture only. Never ship.'},
        'source': 'scripts/make-pet-test-pattern.py',
        'license': 'Project test fixture',
    }
    (OUT / 'pet.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(png, sha)


if __name__ == '__main__':
    main()
