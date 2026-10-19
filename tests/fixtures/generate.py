"""Generate the repository-owned synthetic browser fixture with a local FFmpeg."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--ffmpeg', default='ffmpeg')
parser.add_argument('--font', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if args.output.exists():
    parser.error('Output already exists; use a new path to preserve the old fixture.')
font = args.font.resolve(strict=True).as_posix().replace(':', r'\:').replace("'", r"\'")
filters = ["drawbox=x=72:y=98:w=7:h=290:color=0x73e0cd:t=fill"]
for text, size, y, color in [
    ('LOCAL STUDY DEMO', 46, 130, 'white'),
    ('Synthetic video / no personal course', 28, 210, 'white'),
    ('Pause. Ask. Keep conversations with their video.', 23, 290, '0xa4bdca'),
    ('Offline browser regression fixture', 23, 345, '0xa4bdca'),
]:
    filters.append(f"drawtext=fontfile='{font}':text='{text}':fontsize={size}:x=112:y={y}:fontcolor={color}")
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run([args.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i',
                'color=c=0x143047:s=960x540:r=10:d=2', '-vf', ','.join(filters),
                '-c:v', 'libvpx', '-b:v', '200k', '-pix_fmt', 'yuv420p', '-an', str(args.output)], check=True)
print(args.output.resolve())
