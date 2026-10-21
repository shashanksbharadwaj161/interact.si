"""Review animations cropped from the final encoded atlas; never creates or redraws character artwork."""
import argparse
import json
import runpy
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', type=Path, required=True)
parser.add_argument('--skill-scripts', type=Path, required=True)
parser.add_argument('--ffmpeg-package', type=Path, required=True)
args = parser.parse_args()
run = args.run.resolve()
atlas = Image.open(run / 'final/spritesheet-extended.png').convert('RGBA')
contract = runpy.run_path(str(args.skill_scripts / 'render_animation_previews.py'))
timings = contract['ROW_DURATIONS']
output = run / 'final-previews'
output.mkdir(exist_ok=True)
cells = {state: [atlas.crop((col*192, row*208, (col+1)*192, (row+1)*208)) for col in range(len(durations))] for row, (state, durations) in enumerate(timings.items())}

def gif(name, frames, durations):
    contract['save_preview'](frames, durations, output / name)

# Required native-cell transition: no independent scaling, baseline shift or optical interpolation.
sequence = cells['idle'] + cells['jumping'] + cells['idle']
gif('idle-jump-idle.gif', sequence, timings['idle'] + timings['jumping'] + timings['idle'])
looks = [atlas.crop((col*192, row*208, (col+1)*192, (row+1)*208)) for row in [9,10] for col in range(8)]
gif('look-loop.gif', [cells['idle'][0]] + looks + [cells['idle'][0]], [500] + [220]*16 + [500])

font_path = Path('C:/Windows/Fonts/segoeui.ttf')
font = ImageFont.truetype(str(font_path), 16) if font_path.exists() else ImageFont.load_default()
frames, durations = [], []
for state, times in timings.items():
    for cell, duration in zip(cells[state], times):
        canvas = Image.new('RGBA', (384, 468), '#101725')
        canvas.alpha_composite(cell.resize((384,416), Image.Resampling.LANCZOS), (0,4))
        ImageDraw.Draw(canvas).text((16,436), state.replace('-', ' ') + '  /  animation preview', font=font, fill='#dbe6ff')
        frames.append(canvas.convert('RGB')); durations.append(duration)
gif('all-states.gif', frames, durations)

sys.path.insert(0, str(args.ffmpeg_package.resolve()))
import imageio_ffmpeg
writer = imageio_ffmpeg.write_frames(str(output / 'all-states.mp4'), (384,468), fps=100, codec='libx264', pix_fmt_in='rgb24', pix_fmt_out='yuv420p', macro_block_size=1, output_params=['-crf','19','-movflags','+faststart'])
writer.send(None)
for frame, duration in zip(frames, durations):
    raw = frame.tobytes()
    for _ in range(duration//10): writer.send(raw)
writer.close()

# Four concrete stills, all using known atlas cells.
for state, col in [('idle',2), ('waving',2), ('jumping',2), ('running-right',3)]:
    cells[state][col].save(output / f'still-{state}-{col}.png')
print(json.dumps({'ok':True, 'source':'final/spritesheet-extended.png', 'allStateFrames':len(frames), 'durationMs':sum(durations), 'files':[p.name for p in output.iterdir()]}, indent=2))
