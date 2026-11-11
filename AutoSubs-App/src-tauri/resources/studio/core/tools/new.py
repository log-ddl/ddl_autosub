#!/usr/bin/env python3
"""Tạo một dự án video đúng khung (README.md, mục "Khung một dự án").

    python3 core/tools/new.py <id> [voice.mp3 | script.md] [--skill <tên>] [--format 16:9|9:16|1:1|4:5] [--fps 30] [--from a --to b]

- Có voice: chép (hoặc cắt theo --from/--to, giây) vào assets/voice/voice.mp3, ghi a001, chương C01 phủ cả voice.
- Có kịch bản (.md/.txt): chép vào assets/script/, độ dài để trống tới khi có voice.
- --skill: dùng templates/STORY.md, templates/CHAPTER.md của skills/<tên>/ nếu có, không thì mẫu mặc định.
Không ghi đè dự án đã có.
"""
import json
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = ROOT / 'projects'
SKILLS = ROOT / 'skills'
RUNTIME_PKG = ROOT / 'remotion/package.json'

FORMATS = {'16:9': (1920, 1080), '9:16': (1080, 1920), '1:1': (1080, 1080), '4:5': (1080, 1350)}
DIRS = ['input',
        'assets/voice', 'assets/script', 'assets/footage', 'assets/images', 'assets/music', 'assets/sfx', 'assets/refs',
        'plan/chapters',
        'src/design', 'src/parts', 'src/cues', 'src/scenes', 'src/overlays',
        'out/checks', '.build']
AUDIO = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'}
TEXT = {'.md', '.txt'}

STORY = """# {title}

## Ý chính
Video nói gì, cho ai xem, xem xong người xem phải hiểu điều gì.

## Phong cách
Màu, font, kiểu hình (2D / 3D / footage thật), nhịp dựng, cách máy quay chạy. Code hoá vào src/design/.

## Quy ước chung
Những thứ phải giống nhau suốt video: part dùng lại, nhân vật, ký hiệu, kiểu chữ chú thích.

## Chương
| Chương | Từ–đến (s) | Nội dung | Mở đầu → kết thúc bằng hình gì |
|---|---|---|---|
{chapters}
## Tiến độ
| Chương | Plan | Dựng | Kiểm |
|---|---|---|---|
{progress}"""

CHAPTER = """# {cid} — {title}

Mỗi cảnh: câu voice nào, người xem phải thấy gì, loại cảnh (code / clip / still) và cách thể hiện, chữ trên hình, tiếng động.
Kết quả ghi vào chapters/{cid}.json.

"""


def opt(argv, key, default=None, cast=str):
    return cast(argv[argv.index(key) + 1]) if key in argv else default


def probe(path: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True).stdout.strip()
    return round(float(out), 2) if out else 0.0


def put(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def put_json(path: Path, data):
    put(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def template(skill, name: str, default: str) -> str:
    f = SKILLS / skill / 'templates' / name if skill else None
    return f.read_text() if f and f.is_file() else default


def fill(text: str, **kw) -> str:
    """Điền {khoá} trong template; dấu { } khác (JSON, code mẫu) giữ nguyên."""
    for k, v in kw.items():
        text = text.replace('{' + k + '}', str(v))
    return text


def remotion_version() -> str:
    try:
        return json.loads(RUNTIME_PKG.read_text())['dependencies']['remotion']
    except (OSError, KeyError, ValueError):
        return ''


def main():
    argv = sys.argv[1:]
    flags = ('--skill', '--format', '--fps', '--from', '--to')
    pos = [a for i, a in enumerate(argv) if not a.startswith('--') and (i == 0 or argv[i - 1] not in flags)]
    if not pos:
        sys.exit(__doc__)
    pid = pos[0]
    if not re.fullmatch(r'[a-z][a-z0-9_]*', pid):
        sys.exit('id chỉ gồm chữ thường, số, gạch dưới và bắt đầu bằng chữ')
    pdir = PROJECTS / pid
    if pdir.exists() and any(pdir.iterdir()):
        sys.exit(f'projects/{pid} đã có, không ghi đè')

    src = Path(pos[1]).expanduser() if len(pos) > 1 else None
    if src and not src.is_file():
        sys.exit(f'không thấy file: {src}')
    if src and src.suffix.lower() not in AUDIO | TEXT:
        sys.exit(f'chỉ nhận voice ({", ".join(sorted(AUDIO))}) hoặc kịch bản (.md, .txt): {src.name}')
    skill = opt(argv, '--skill')
    if skill and not (SKILLS / skill).is_dir():
        sys.exit(f'chưa có skill "{skill}" trong skills/')
    fmt = opt(argv, '--format', '16:9')
    if fmt not in FORMATS:
        sys.exit(f'--format phải là một trong: {", ".join(FORMATS)}')
    width, height = FORMATS[fmt]
    fps = opt(argv, '--fps', 30, int)
    a, b = opt(argv, '--from', None, float), opt(argv, '--to', None, float)

    for d in DIRS:
        (pdir / d).mkdir(parents=True, exist_ok=True)

    assets, duration = [], None
    if src and src.suffix.lower() in AUDIO:
        voice = pdir / 'assets/voice/voice.mp3'
        if a is not None or b is not None:
            cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(a or 0), '-i', str(src)]
            if b is not None:
                cmd += ['-t', str(b - (a or 0))]
            subprocess.run(cmd + ['-af', 'afade=t=in:d=0.05', '-c:a', 'libmp3lame', '-q:a', '2', str(voice)], check=True)
        elif src.suffix.lower() == '.mp3':
            shutil.copy2(src, voice)
        else:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src), '-c:a', 'libmp3lame', '-q:a', '2', str(voice)], check=True)
        duration = probe(voice)
        assets.append({'id': 'a001', 'kind': 'voice', 'file': 'voice/voice.mp3', 'status': 'have', 'source': 'user',
                       'locked': True, 'tags': [], 'duration': duration, 'used': []})
    elif src:
        shutil.copy2(src, pdir / 'assets/script' / f'script{src.suffix.lower()}')
        assets.append({'id': 'a001', 'kind': 'script', 'file': f'script/script{src.suffix.lower()}', 'status': 'have',
                       'source': 'user', 'locked': True, 'tags': [], 'used': []})

    rel = (lambda p: str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p))(src.resolve()) if src else None
    put_json(pdir / 'project.json', {
        'id': pid, 'title': '', 'skill': skill, 'width': width, 'height': height, 'fps': fps,
        'remotion': remotion_version(), 'source': {'file': rel, 'from': a, 'to': b},
        'duration': duration, 'created': date.today().isoformat()})
    put_json(pdir / 'assets/ASSETS.json', {'next': len(assets) + 1, 'assets': assets})

    if duration:
        put_json(pdir / 'plan/chapters/C01.json', {'id': 'C01', 'title': '', 'from': 0, 'to': duration, 'scenes': [], 'sfx': []})
        put(pdir / 'plan/chapters/C01.md', fill(template(skill, 'CHAPTER.md', CHAPTER), cid='C01', title=''))
        put(pdir / 'src/cues/C01.ts', '// Mốc voice (giây) của chương C01, khoá bắt đầu bằng c01_.\nexport const CUE = {} as const;\n')
        chapters, progress = f'| C01 | 0–{duration} | | |\n', '| C01 | ⬜ | ⬜ | ⬜ |\n'
    else:
        chapters = progress = ''
    put(pdir / 'plan/STORY.md', fill(template(skill, 'STORY.md', STORY), title=pid, chapters=chapters, progress=progress, duration=duration or '?'))
    synth = {'synth': {'pad': 2.0, 'root': 38, 'hits': [], 'bass': [[2.0, duration, 0.6]], 'hats': [duration, duration],
                       'riser': [duration - 0.1, duration]}} if duration else None
    put_json(pdir / 'plan/mix.json', {'volume': {'voice': 1.0, 'music': 0.4, 'sfx': 0.5}, 'music': [synth] if synth else []})
    put(pdir / '.gitignore', '.build/\nout/\ninput/\n')

    print(f'projects/{pid}/  {width}x{height} {fps}fps  skill {skill or "—"}  '
          + (f'voice {duration}s' if duration else 'kịch bản' if src else 'trống'))
    if duration:
        print(f'Tiếp: .venv/bin/python core/tools/asr.py {pid}')


if __name__ == '__main__':
    main()
