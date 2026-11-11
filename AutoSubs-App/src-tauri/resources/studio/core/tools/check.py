#!/usr/bin/env python3
"""Ảnh kiểm (nhiều khung ghép lưới) cho một dự án → out/checks/. Mốc giây từng ô in ra stdout và ghi file .txt cạnh ảnh.

    python3 core/tools/check.py <id>                         cả video → out/checks/sheet.png (24 khung, cần build trước)
    python3 core/tools/check.py <id> --from 40 --to 60       một đoạn → out/checks/sheet_40-60.png (cần build)
    python3 core/tools/check.py <id> --chapter C03           một chương → out/checks/chapters/C03.png (2 khung/cảnh, 12–36; cần build)
    python3 core/tools/check.py <id> --seams [C03,C04]       chỗ nối chương ±1.5 s → out/checks/seams/C03-C04.png (cần build)
    python3 core/tools/check.py <id> --scene C01S02,C01S03   từng cảnh cô lập → out/checks/scenes/C01S02.png (6 khung; KHÔNG cần build)
    python3 core/tools/check.py <id> --part F16,HostGirl     part cô lập theo `preview` của nó → out/checks/parts/F16.png ('all' = mọi part)
    tuỳ chọn: --n 6  --cols 3  --width 960  --force (chụp lại kể cả chưa đổi code)  --full (render đủ độ phân giải)

--scene và --part tự kiểm kiểu riêng (cache incremental trong .build/check/), bỏ qua mục chưa đổi code,
và giới hạn tối đa 4 tiến trình Chrome render cùng lúc trên máy, nên nhiều subagent gọi song song an toàn.
"""
import contextlib
import fcntl
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from common import (asset_refs, comp_id, load, need, opt, remotion, scene_spec_ts, sync_assets, sync_cues, timeline, tsc,
                    write_if_changed, write_tsconfig)

MAX_PARALLEL_RENDERS = 4


@contextlib.contextmanager
def render_slot(max_slots: int = MAX_PARALLEL_RENDERS):
    """Giới hạn số tiến trình Chrome/Remotion render đồng thời trên máy (kernel tự nhả khóa nếu tiến trình chết)."""
    lock_dir = Path(tempfile.gettempdir()) / 'video_studio_render_locks'
    lock_dir.mkdir(exist_ok=True)
    fh, start = None, os.getpid() % max_slots
    while fh is None:
        for k in range(max_slots):
            f = open(lock_dir / f'slot_{(start + k) % max_slots}.lock', 'w')
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fh = f
                break
            except BlockingIOError:
                f.close()
        if fh is None:
            time.sleep(0.35)
    try:
        yield
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


@contextlib.contextmanager
def work_lock(work: Path):
    """Khoá thư mục cache để giữ tsbuildinfo an toàn giữa các lần chạy song song."""
    work.mkdir(parents=True, exist_ok=True)
    lf = open(work / '.lock', 'w')
    try:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        yield work
    finally:
        fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
        lf.close()


def render_scale(tile: int, frame_w: int, full: bool) -> float:
    """--scale của Remotion khớp đúng bề rộng ô ảnh (1.0 khi --full)."""
    return 1.0 if full else max(0.25, min(1.0, round(tile / frame_w, 4)))


def tile_frames(frames: list, td: Path, cols: int, width: int, out: Path):
    """Đánh số lại bằng symlink rồi scale + ghép lưới trong một lệnh ffmpeg, ghi nguyên tử."""
    ext = frames[0].suffix
    for i, fr in enumerate(frames):
        link = td / f'l{i:03d}{ext}'
        if link.exists() or link.is_symlink():
            link.unlink()
        os.symlink(fr.resolve(), link)
    rows = (len(frames) + cols - 1) // cols
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = td / f'out_{os.getpid()}{out.suffix}'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '1', '-i', str(td / f'l%03d{ext}'),
                    '-vf', f'scale={width}:-1,tile={cols}x{rows}:padding=4', '-frames:v', '1', str(tmp)], check=True)
    os.replace(tmp, out)


def write_secs(out: Path, secs: str):
    write_if_changed(out.with_suffix('.txt'), secs + '\n')


def latest_mtime(paths: list) -> float:
    mt = 0.0
    for p in paths:
        if p.is_file():
            mt = max(mt, p.stat().st_mtime)
        elif p.is_dir():
            mt = max([mt] + [f.stat().st_mtime for f in p.rglob('*') if f.is_file() and f.suffix in ('.ts', '.tsx', '.json')])
    return mt


def rel(p: Path, base: Path) -> str:
    return Path(os.path.relpath(p, base)).as_posix()


def typecheck(work: Path, label: str):
    write_tsconfig(work / 'tsconfig.json', ['./entry.tsx'], {'incremental': True, 'tsBuildInfoFile': './tsconfig.tsbuildinfo'})
    errs = tsc(work / 'tsconfig.json')
    if errs:
        print(f'LỖI TypeScript khi kiểm {label}:')
        for e in errs[:30]:
            print('  ', e)
        sys.exit(1)


def render_frames(target: str, comp: str, frames: str, step: int, scale: float, td: Path, pub: list):
    r = remotion(['render', target, comp, str(td / 'f'), '--sequence', '--image-format=jpeg', f'--frames={frames}',
                  f'--every-nth-frame={step}', f'--scale={scale}', '--muted', *pub, '--log=error'], capture_output=True, text=True)
    shots = sorted((td / 'f').glob('*.jpeg'))
    if r.returncode or not shots:
        print(r.stdout[-3000:], r.stderr[-3000:])
        sys.exit(f'render lỗi ({comp})')
    return shots


def bundle(entry: Path, td: Path, pdir: Path):
    rb = remotion(['bundle', str(entry), f'--out-dir={td / "bundle"}', f'--public-dir={pdir / ".build/public"}', '--log=error'],
                  capture_output=True, text=True)
    if rb.returncode:
        print(rb.stdout[-3000:], rb.stderr[-3000:])
        sys.exit('bundle lỗi')
    return str(td / 'bundle')


# ---------------------------------------------------------------- cả video / đoạn / chương / chỗ nối (cần build)

def shoot(pdir: Path, proj: dict, a: float, b: float, n: int, cols: int, width: int, out: Path, full: bool):
    fps = proj['fps']
    f0, f1 = round(a * fps), max(round(a * fps), round(b * fps) - 1)
    step = max(1, (f1 - f0) // max(1, n - 1)) if n > 1 else f1 - f0 + 1
    with tempfile.TemporaryDirectory() as td, render_slot():
        tdp = Path(td)
        shots = render_frames(str(pdir / '.build/entry.tsx'), comp_id(pdir.name), f'{f0}-{f1}', step,
                              render_scale(width, proj['width'], full), tdp,
                              [f'--public-dir={pdir / ".build/public"}', '--props={"music":false,"sfx":false}'])[:n]
        tile_frames(shots, tdp, cols, width, out)
    secs = ' '.join(f'{(f0 + i * step) / fps:.2f}' for i in range(len(shots)))
    write_secs(out, secs)
    print(out, '\n  mốc (giây):', secs)


# ---------------------------------------------------------------- cảnh cô lập

def shoot_scenes(pdir: Path, proj: dict, want: list, n: int, cols: int, width: int, force: bool, full: bool):
    tl = timeline(pdir)
    by = {s['id']: s for s in tl['scenes']}
    for sid in want:
        if sid not in by:
            sys.exit(f'không có cảnh {sid} trong plan/chapters/')
        s = by[sid]
        if (s['type'] == 'code' or s.get('overlay')) and not (pdir / 'src/scenes' / f'{sid}.tsx').exists():
            sys.exit(f'chưa có file src/scenes/{sid}.tsx')
    sync_cues(pdir)
    files = [f for f in (pdir / 'src').rglob('*.ts*') if f.parent.name != 'scenes' or f.stem in want]
    ids = set(asset_refs(pdir, files)) | {by[s]['asset'] for s in want if by[s].get('asset')}
    errs = sync_assets(pdir, ids)
    if errs:
        sys.exit('THIẾU tài sản: ' + '; '.join(errs))

    fps, w, h = proj['fps'], proj['width'], proj['height']
    with work_lock(pdir / '.build/check' / ('scene_' + '_'.join(want))) as work:
        imports = ["import '" + rel(pdir / '.build/assets', work) + "';", "import { Composition, registerRoot } from 'remotion';", "import { SceneView } from '@core/timeline';"]
        comps, plan = [], {}
        for sid in want:
            s = by[sid]
            comp = None
            if (pdir / 'src/scenes' / f'{sid}.tsx').exists():
                imports.append(f"import {sid} from '{rel(pdir / 'src/scenes' / sid, work)}';")
                comp = sid
            ts, imp = scene_spec_ts(dict(s, transition='cut'), comp, w, h)
            pad = min(0.3, (s['to'] - s['from']) / 10)
            f0, f1 = round((s['from'] + pad) * fps), round((s['to'] - pad) * fps) - 1
            f1 = max(f0, f1)
            step = max(1, (f1 - f0) // max(1, n - 1)) if n > 1 else f1 - f0 + 1
            base = max(0, round(s['from'] * fps) - 6)
            dur = max(f1 + 1, round(s['to'] * fps) + 6) - base
            comps.append(f'    <Composition id="scene-{sid}" component={{() => <SceneView s={{{ts}}} t0={{{base / fps:.6f}}} />}} '
                         f'durationInFrames={{{dur}}} fps={{{fps}}} width={{{w}}} height={{{h}}} />')
            plan[sid] = (f0, f0 - base, f1 - base, step)
        write_if_changed(work / 'entry.tsx', '\n'.join(imports) + '\n\nregisterRoot(() => (\n  <>\n' + '\n'.join(comps) + '\n  </>\n));\n')
        typecheck(work, f"cảnh {', '.join(want)}")

        shared = latest_mtime([pdir / 'src/design', pdir / 'src/parts', pdir / 'src/cues', pdir / 'assets/ASSETS.json'])
        dirty = []
        for sid in want:
            out = pdir / 'out/checks/scenes' / f'{sid}.png'
            src = pdir / 'src/scenes' / f'{sid}.tsx'
            mt = max(shared, (pdir / 'plan/chapters' / f"{by[sid]['chapter']}.json").stat().st_mtime, src.stat().st_mtime if src.exists() else 0)
            txt = out.with_suffix('.txt')
            if not force and not full and out.exists() and txt.exists() and out.stat().st_mtime >= mt and len(txt.read_text().split()) == n:
                print(f'{out}  [bỏ qua: chưa đổi code — thêm --force để chụp lại]')
            else:
                dirty.append(sid)
        if not dirty:
            return
        with tempfile.TemporaryDirectory(dir=work, prefix='shots_') as td, render_slot():
            tdp = Path(td)
            target, pub = (bundle(work / 'entry.tsx', tdp, pdir), []) if len(dirty) > 1 else \
                (str(work / 'entry.tsx'), [f'--public-dir={pdir / ".build/public"}'])
            for sid in dirty:
                f0, lf0, lf1, step = plan[sid]
                sd = tdp / sid
                sd.mkdir()
                shots = render_frames(target, f'scene-{sid}', f'{lf0}-{lf1}', step, render_scale(width, w, full), sd, pub)[:n]
                out = pdir / 'out/checks/scenes' / f'{sid}.png'
                tile_frames(shots, sd, cols, width, out)
                secs = ' '.join(f'{(f0 + i * step) / fps:.2f}' for i in range(len(shots)))
                write_secs(out, secs)
                print(out, '\n  mốc (giây):', secs)


# ---------------------------------------------------------------- part cô lập

def shoot_parts(pdir: Path, proj: dict, raw: str, width: int, force: bool, full: bool):
    pdirs = pdir / 'src/parts'
    have = {f.stem: f for f in sorted(pdirs.glob('*.tsx')) if re.search(r'\bexport\s+const\s+preview\b', f.read_text())} if pdirs.is_dir() else {}
    names = list(have) if raw == 'all' else [x.strip() for x in raw.split(',') if x.strip()]
    for nm in names:
        if nm not in have:
            sys.exit(f"part '{nm}' không có hoặc chưa export preview (có: {', '.join(have) or 'trống'})")
    if not names:
        sys.exit('chưa có part nào export preview trong src/parts/')
    sync_cues(pdir)
    errs = sync_assets(pdir, asset_refs(pdir, [f for f in (pdir / 'src').rglob('*.ts*') if f.parent.name != 'scenes']))
    if errs:
        sys.exit('THIẾU tài sản: ' + '; '.join(errs))
    w, h = proj['width'], proj['height']
    tag = 'part_' + '_'.join(names[:6]) + (f'_{len(names)}' if len(names) > 6 else '')
    with work_lock(pdir / '.build/check' / tag) as work:
        imports = ["import '" + rel(pdir / '.build/assets', work) + "';", "import { Composition, registerRoot } from 'remotion';", "import { PreviewHost } from '@core/preview';"]
        comps = []
        for nm in names:
            imports.append(f"import {{ preview as P_{nm} }} from '{rel(have[nm].with_suffix(''), work)}';")
            comps.append(f'    <Composition id="part-{nm}" component={{() => <PreviewHost preview={{P_{nm}}} />}} '
                         f'durationInFrames={{P_{nm}.views}} fps={{30}} width={{{w}}} height={{{h}}} />')
        write_if_changed(work / 'entry.tsx', '\n'.join(imports) + '\n\nregisterRoot(() => (\n  <>\n' + '\n'.join(comps) + '\n  </>\n));\n')
        typecheck(work, f"part {', '.join(names)}")
        shared = latest_mtime([pdir / 'src/design', pdirs])
        dirty = [nm for nm in names if force or full or not (pdir / 'out/checks/parts' / f'{nm}.png').exists()
                 or (pdir / 'out/checks/parts' / f'{nm}.png').stat().st_mtime < shared]
        for nm in set(names) - set(dirty):
            print(f"{pdir / 'out/checks/parts' / f'{nm}.png'}  [bỏ qua: chưa đổi code — thêm --force để chụp lại]")
        if not dirty:
            return
        with tempfile.TemporaryDirectory(dir=work, prefix='shots_') as td, render_slot():
            tdp = Path(td)
            target = bundle(work / 'entry.tsx', tdp, pdir)
            for nm in dirty:
                sd = tdp / nm
                sd.mkdir()
                r = remotion(['render', target, f'part-{nm}', str(sd / 'f'), '--sequence', '--image-format=jpeg',
                              f'--scale={render_scale(width, w, full)}', '--muted', '--log=error'], capture_output=True, text=True)
                shots = sorted((sd / 'f').glob('*.jpeg'))
                if r.returncode or not shots:
                    print(r.stdout[-3000:], r.stderr[-3000:])
                    sys.exit(f'render lỗi ở part {nm}')
                out = pdir / 'out/checks/parts' / f'{nm}.png'
                tile_frames(shots, sd, 2 if len(shots) == 4 else min(len(shots), 4), width, out)
                print(out, f'  ({len(shots)} góc)')


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    pdir = need(argv[0])
    proj = load(pdir / 'project.json')
    force, full = '--force' in argv, '--full' in argv

    if '--scene' in argv:
        want = list(dict.fromkeys(x.strip() for x in (opt(argv, '--scene') or '').split(',') if x.strip()))
        if not want:
            sys.exit('chưa chỉ định cảnh sau --scene (ví dụ: --scene C01S01,C01S02)')
        shoot_scenes(pdir, proj, want, opt(argv, '--n', 6, int), opt(argv, '--cols', 3, int), opt(argv, '--width', 960, int), force, full)
        return
    if '--part' in argv:
        shoot_parts(pdir, proj, opt(argv, '--part') or sys.exit('chưa chỉ định part sau --part (tên hoặc all)'),
                    opt(argv, '--width', 960, int), force, full)
        return

    if not (pdir / '.build/entry.tsx').exists():
        sys.exit(f'chưa build (python3 core/tools/build.py {pdir.name})')
    tl = load(pdir / 'plan/timeline.json')
    chs = tl['chapters']
    out = pdir / 'out/checks'

    if '--seams' in argv:
        if len(chs) < 2:
            sys.exit('cần ít nhất 2 chương')
        i = argv.index('--seams') + 1
        only = {x.strip() for x in argv[i].split(',')} if i < len(argv) and not argv[i].startswith('--') else set()
        for c0, c1 in zip(chs, chs[1:]):
            if not only or c0['id'] in only or c1['id'] in only:
                t = c1['from']
                shoot(pdir, proj, max(0.0, t - 1.5), t + 1.5, opt(argv, '--n', 6, int), opt(argv, '--cols', 6, int),
                      opt(argv, '--width', 480, int), out / 'seams' / f"{c0['id']}-{c1['id']}.png", full)
        return
    if '--chapter' in argv:
        cid = opt(argv, '--chapter')
        c = next((c for c in chs if c['id'] == cid), None) or sys.exit(f'không có chương {cid}')
        k = sum(s['chapter'] == cid for s in tl['scenes'])
        shoot(pdir, proj, c['from'], c['to'], opt(argv, '--n', max(12, min(36, 2 * k)), int), opt(argv, '--cols', 6, int),
              opt(argv, '--width', 480, int), out / 'chapters' / f'{cid}.png', full)
        return
    a, b = opt(argv, '--from', 0.0, float), opt(argv, '--to', tl['duration'], float)
    name = 'sheet.png' if '--from' not in argv and '--to' not in argv else f'sheet_{a:g}-{b:g}.png'
    shoot(pdir, proj, a, b, opt(argv, '--n', 24, int), opt(argv, '--cols', 6, int), opt(argv, '--width', 480, int), out / name, full)


if __name__ == '__main__':
    shutil.which('ffmpeg') or sys.exit('cần ffmpeg')
    main()
