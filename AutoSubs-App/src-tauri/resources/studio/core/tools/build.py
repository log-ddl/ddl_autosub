#!/usr/bin/env python3
"""Ráp một dự án: gộp plan/chapters/*.json → plan/timeline.json, sinh .build/ (entry, Video, sổ tài sản), kiểm lỗi code.

    python3 core/tools/build.py <id> [--strict]

- Kiểm: chương nối liền, cảnh liền mạch và phủ đúng chương, mã tài sản có file, CUE không trùng tên.
- Cảnh code chưa có file hoặc lỗi kiểu → khung giữ chỗ (in tên cảnh + lỗi); các cảnh khác vẫn xem được.
  --strict: có cảnh lỗi, cảnh chưa dựng hay tài sản thiếu thì thoát mã 1.
- Lỗi ngoài src/scenes/ (design/, parts/, cues/, overlays/) làm hỏng mọi cảnh nên luôn báo lỗi và thoát.
- Tài sản dùng (cảnh clip/still + asset('aNNN') trong src/) được link vào .build/public/assets/; cột "used" trong ASSETS.json cập nhật.
"""
import re
import subprocess
import sys

from common import (SCENE_ID, assets, asset_refs, comp_id, link_file, load, need, save_json, scene_spec_ts, sync_assets, sync_cues,
                    timeline, tsc, write_if_changed, write_tsconfig)


def has_code(pdir, s):
    return (s['type'] == 'code' or s.get('overlay')) and (pdir / 'src/scenes' / f"{s['id']}.tsx").exists()


def write_video(pdir, tl, bad):
    imports, specs, used = [], [], set()
    holder = False
    for s in tl['scenes']:
        comp = None
        if s['id'] in bad:
            comp, holder = f"placeholder('{s['id']}', '{bad[s['id']][:120]}')", True
        elif has_code(pdir, s):
            imports.append(f"import {s['id']} from '../src/scenes/{s['id']}';")
            comp = s['id']
        elif s['type'] == 'code':
            comp, holder = f"placeholder('{s['id']}', '{'chưa plan' if s.get('pending') else 'chưa dựng'}')", True
        ts, imp = scene_spec_ts(s, comp, tl['width'], tl['height'])
        specs.append(ts)
        if imp:
            used.add(imp)
    overlays = sorted((pdir / 'src/overlays').glob('*.tsx'))
    imports += [f"import Overlay_{f.stem} from '../src/overlays/{f.stem}';" for f in overlays]
    write_if_changed(pdir / '.build/Video.tsx', f"""// SINH TỰ ĐỘNG bởi core/tools/build.py từ plan/timeline.json — không sửa tay.
import type {{ VideoSpec }} from '@core/timeline';
{"import { placeholder } from '@core/timeline';" if holder else ''}
{chr(10).join(sorted(used))}
{chr(10).join(imports)}

export const spec: VideoSpec = {{
  fps: {tl['fps']},
  music: {tl['volume']['music']}, sfx: {tl['volume']['sfx']},
  scenes: [
    {(',' + chr(10) + '    ').join(specs)},
  ],
  overlays: [{', '.join(f'Overlay_{f.stem}' for f in overlays)}],
}};
""")
    cid = comp_id(tl['id'])
    write_if_changed(pdir / '.build/entry.tsx', f"""// SINH TỰ ĐỘNG bởi core/tools/build.py — entry Remotion chỉ chứa dự án {tl['id']}.
import './assets';
import React from 'react';
import {{ Composition, registerRoot }} from 'remotion';
import {{ VideoTimeline, durationOf, propsSchema }} from '@core/timeline';
import {{ spec }} from './Video';

// Bật/tắt nhạc nền và tiếng động ở bảng Props của Studio; render.py truyền cờ --no-music / --no-sfx.
const Main: React.FC<{{ music: boolean; sfx: boolean }}> = (p) => <VideoTimeline spec={{spec}} music={{p.music}} sfx={{p.sfx}} />;

registerRoot(() => (
  <Composition id="{cid}" component={{Main}} schema={{propsSchema}} defaultProps={{{{ music: true, sfx: true }}}}
    durationInFrames={{durationOf(spec)}} fps={{spec.fps}} width={{{tl['width']}}} height={{{tl['height']}}} />
));
""")


def silent(path, dur, mp3=False):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', f'{dur:.3f}',
                    *(['-c:a', 'libmp3lame', '-q:a', '6'] if mp3 else []), str(path)], check=True)


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    pdir = need(argv[0])
    tl = timeline(pdir)
    save_json(pdir / 'plan/timeline.json', tl)
    sync_cues(pdir)

    # Tài sản: cảnh clip/still + asset('…') trong code
    refs = asset_refs(pdir)
    for s in tl['scenes']:
        if s.get('asset'):
            refs.setdefault(s['asset'], []).append(s['id'])
    missing = sync_assets(pdir, refs)
    book = load(pdir / 'assets/ASSETS.json')
    for a in book['assets']:
        a['used'] = sorted(set(refs.get(a['id'], [])))
    save_json(pdir / 'assets/ASSETS.json', book)

    # Code: kiểm kiểu theo cây import từ entry; cảnh lỗi → giữ chỗ rồi kiểm lại
    write_tsconfig(pdir / '.build/tsconfig.json', ['entry.tsx'])
    write_video(pdir, tl, {})
    errs = tsc(pdir / '.build/tsconfig.json')
    bad, other = {}, []
    for e in errs:
        m = re.search(rf'src/scenes/({SCENE_ID})\.tsx', e)
        if m:
            bad.setdefault(m.group(1), e.split('error ')[-1].replace("'", '’'))
        else:
            other.append(e)
    if other:
        print('\n'.join(other[:30]))
        sys.exit('LỖI ngoài src/scenes/ (design/, parts/, cues/, overlays/…): sửa trước khi build')
    if bad:
        write_video(pdir, tl, bad)
        left = [e for e in tsc(pdir / '.build/tsconfig.json') if 'src/scenes/' not in e]
        if left:
            print('\n'.join(left[:30]))
            sys.exit('LỖI sau khi thay khung giữ chỗ')

    # Âm thanh: voice luôn mới nhất; chưa có voice thì im lặng; music/sfx im lặng tới khi chạy audio.py
    pub = pdir / '.build/public'
    voice = next((pdir / 'assets' / a['file'] for a in assets(pdir).values() if a['kind'] == 'voice' and a.get('file') == 'voice/voice.mp3'), None)
    if voice and voice.exists():
        link_file(voice, pub / 'voice.mp3')
    else:
        silent(pub / 'voice.mp3', tl['duration'], mp3=True)
    for name in ('music.wav', 'sfx.wav'):
        silent(pub / name, 1.0)

    code = [s for s in tl['scenes'] if s['type'] == 'code']
    todo = [s['id'] for s in tl['scenes'] if (s['type'] == 'code' or s.get('overlay')) and not has_code(pdir, s)]
    print(f"{tl['id']}: {len(tl['chapters'])} chương, {len(tl['scenes'])} cảnh "
          f"(code {len(code)}, clip {sum(s['type'] == 'clip' for s in tl['scenes'])}, still {sum(s['type'] == 'still' for s in tl['scenes'])}) "
          f"— chưa dựng {len(todo)}, lỗi {len(bad)}, tài sản {len(refs) - len(missing)}/{len(refs)}")
    for sid, why in bad.items():
        print(f'  LỖI {sid}: {why}')
        for e in errs:
            if f'scenes/{sid}.tsx' in e:
                print('     ', e.split('src/')[-1])
    for m in missing:
        print(f'  THIẾU tài sản {m}')
    if (bad or missing or todo) and '--strict' in argv:
        sys.exit(1)


if __name__ == '__main__':
    main()
