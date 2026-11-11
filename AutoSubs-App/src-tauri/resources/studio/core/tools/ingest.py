#!/usr/bin/env python3
"""Đưa file vào kho tài sản của dự án: xếp vào assets/<loại>/, cấp mã aNNN, ghi assets/ASSETS.json (đo kích thước, độ dài).

    python3 core/tools/ingest.py <id>                       xếp mọi file trong input/ (của người dùng: locked) rồi để input/ trống
    python3 core/tools/ingest.py <id> <file>... [tuỳ chọn]  chép file từ chỗ khác vào (library/, file vừa tải…)
      --kind footage|image|music|sfx|voice|script|ref       ép loại (mặc định đoán theo đuôi, tên, độ dài)
      --source youtube --url URL --license CC-BY            nguồn (mặc định: user cho input/, library cho library/, local còn lại)
      --tags map,night   --note "…"
      --fill a003                                           file này đáp ứng mục "need" a003 (chỉ một file)
In ra mã mới của từng file.
"""
import re
import shutil
import sys
import unicodedata
from pathlib import Path

from common import LIBRARY, load, need, opt, probe, probe_size, save_json

DIRS = {'voice': 'voice', 'script': 'script', 'footage': 'footage', 'image': 'images', 'music': 'music', 'sfx': 'sfx', 'ref': 'refs'}
AUDIO = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aif', '.aiff'}
VIDEO = {'.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'}
IMAGE = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'}
SFX_WORDS = re.compile(r'sfx|whoosh|swoosh|boom|hit|impact|click|riser|explo|shot|gun|beep|swish|pop|ding', re.I)


def guess(f: Path) -> str:
    ext, name = f.suffix.lower(), f.stem.lower()
    if ext in VIDEO:
        return 'footage'
    if ext in IMAGE:
        return 'image'
    if ext in AUDIO:
        if 'voice' in name or 'vo_' in name or 'narr' in name:
            return 'voice'
        if 'sfx' in f.parent.name.lower() or SFX_WORDS.search(name) or probe(f) < 10:
            return 'sfx'
        return 'music'
    if ext in ('.md', '.txt', '.docx') and re.search(r'script|kich|kịch', name):
        return 'script'
    return 'ref'


def slug(name: str) -> str:
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_') or 'file'


def place(pdir: Path, f: Path, kind: str, move: bool) -> str:
    d = pdir / 'assets' / DIRS[kind]
    d.mkdir(parents=True, exist_ok=True)
    stem, ext = slug(f.stem), f.suffix.lower()
    dst = d / f'{stem}{ext}'
    k = 2
    while dst.exists():
        dst, k = d / f'{stem}_{k}{ext}', k + 1
    (shutil.move if move else shutil.copy2)(str(f), dst)
    return str(dst.relative_to(pdir / 'assets'))


def measure(pdir: Path, rel: str, kind: str) -> dict:
    f = pdir / 'assets' / rel
    m = {}
    if kind in ('footage', 'image'):
        w, h = probe_size(f)
        if w:
            m |= {'width': w, 'height': h}
    if kind in ('footage', 'music', 'sfx', 'voice'):
        m['duration'] = probe(f)
    return m


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    pdir = need(argv[0])
    vals = ('--kind', '--source', '--url', '--license', '--tags', '--note', '--fill')
    files = [Path(a).expanduser() for i, a in enumerate(argv[1:], 1) if not a.startswith('--') and argv[i - 1] not in vals]
    from_input = not files
    if from_input:
        files = sorted(f for f in (pdir / 'input').rglob('*') if f.is_file() and not f.name.startswith('.'))
        if not files:
            sys.exit('input/ đang trống')
    for f in files:
        if not f.is_file():
            sys.exit(f'không thấy file: {f}')
    kind = opt(argv, '--kind')
    if kind and kind not in DIRS:
        sys.exit(f"--kind phải là một trong: {', '.join(DIRS)}")
    fill = opt(argv, '--fill')
    if fill and len(files) != 1:
        sys.exit('--fill chỉ đi với đúng một file')

    book = load(pdir / 'assets/ASSETS.json')
    by = {a['id']: a for a in book['assets']}
    if fill and (fill not in by or by[fill].get('status') != 'need'):
        sys.exit(f'{fill} không phải mục đang "need" trong ASSETS.json')
    tags = [t for t in (opt(argv, '--tags') or '').split(',') if t]
    for f in files:
        k = kind or (by[fill]['kind'] if fill else guess(f))
        if k == 'voice' and not (pdir / 'assets/voice/voice.mp3').exists() and f.suffix.lower() == '.mp3':
            (pdir / 'assets/voice').mkdir(parents=True, exist_ok=True)
            (shutil.move if from_input else shutil.copy2)(str(f), pdir / 'assets/voice/voice.mp3')
            rel = 'voice/voice.mp3'
        else:
            rel = place(pdir, f, k, move=from_input)
        if from_input:
            source = 'user'
        elif f.resolve().is_relative_to(LIBRARY.resolve()):
            source = 'library'
        else:
            source = opt(argv, '--source', 'local')
        entry = {'kind': k, 'file': rel, 'status': 'have', 'source': source, 'locked': from_input,
                 'tags': sorted(set(tags) | set(by[fill].get('tags', []) if fill else [])), 'used': by[fill].get('used', []) if fill else [],
                 'original': f.name} | measure(pdir, rel, k)
        for key in ('url', 'license', 'note'):
            if opt(argv, f'--{key}'):
                entry[key] = opt(argv, f'--{key}')
        if fill:
            by[fill].update(entry)
            aid = fill
        else:
            aid = f"a{book['next']:03d}"
            book['next'] += 1
            book['assets'].append({'id': aid} | entry)
        extra = ' '.join(f'{x}={entry[x]}' for x in ('width', 'height', 'duration') if x in entry)
        print(f'{aid}  {k:<8} assets/{rel}  {extra}')
    save_json(pdir / 'assets/ASSETS.json', book)
    if from_input:
        for d in sorted((pdir / 'input').rglob('*'), reverse=True):
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()


if __name__ == '__main__':
    main()
