#!/usr/bin/env python3
"""Xuất mp4 hoặc mở Studio cho một dự án (chỉ đóng gói đúng dự án đó). Chạy build.py và audio.py trước.

    python3 core/tools/render.py <id>                       → projects/<id>/out/video.mp4 (voice + nhạc + sfx)
    python3 core/tools/render.py <id> --no-music --no-sfx   bỏ nhạc nền / tiếng động khỏi bản xuất
    python3 core/tools/render.py <id> --resume              giữ các phần đã xuất xong ở lần trước, chỉ xuất phần còn thiếu
    python3 core/tools/render.py <id> --studio              → Studio ở port riêng của dự án (bật/tắt music, sfx ở bảng Props)

Hình xuất theo từng chương (chương dài hơn PART khung thì chia đều), mỗi phần một Chrome mới, không tiếng,
vào out/parts/; rồi ghép bằng ffmpeg và trộn voice/nhạc/sfx từ .build/public đúng âm lượng như trong Studio.
Một Chrome render liền hàng vạn khung 3D sẽ sập (Page crashed), chia phần thì mỗi Chrome chỉ gánh một đoạn ngắn.
"""
import json
import shutil
import subprocess
import sys

from common import comp_id, need, remotion, studio_port, timeline

PART = 6000  # khung tối đa mỗi phần


def parts(tl: dict) -> list:
    """[(đầu, cuối)] khung, cuối tính cả; theo chương, chương dài chia đều."""
    fps, total = tl['fps'], round(tl['duration'] * tl['fps'])
    cuts = sorted({0, total} | {round(c['from'] * fps) for c in tl['chapters'] if 0 < c['from'] * fps < total})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        n = -(-(b - a) // PART)
        out += [(a + (b - a) * i // n, a + (b - a) * (i + 1) // n - 1) for i in range(n)]
    return out


def mix_audio(pdir, video, out, props, vol, seconds):
    pub = pdir / '.build/public'
    tracks = [(pub / 'voice.mp3', 1.0)]
    if props['music'] and vol['music']:
        tracks.append((pub / 'music.wav', vol['music']))
    if props['sfx'] and vol['sfx']:
        tracks.append((pub / 'sfx.wav', vol['sfx']))
    inputs = [x for f, _ in tracks for x in ('-i', str(f))]
    chains = ''.join(f'[{i + 1}:a]volume={v}[a{i}];' for i, (_, v) in enumerate(tracks))
    mix = ''.join(f'[a{i}]' for i in range(len(tracks))) + f'amix=inputs={len(tracks)}:normalize=0:duration=longest[aout]'
    cmd = ['ffmpeg', '-y', '-v', 'error', '-i', str(video), *inputs, '-filter_complex', chains + mix,
           '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-t', f'{seconds:.3f}',
           '-movflags', '+faststart', str(out)]
    return subprocess.run(cmd).returncode


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    pdir = need(argv[0])
    entry = pdir / '.build/entry.tsx'
    if not entry.exists():
        sys.exit(f'chưa build (python3 core/tools/build.py {pdir.name})')
    pub = f'--public-dir={pdir / ".build/public"}'
    if '--studio' in argv:
        port = studio_port(pdir.name)
        print(f'http://localhost:{port}/{comp_id(pdir.name)}')
        sys.exit(remotion(['studio', str(entry), pub, f'--port={port}']).returncode)
    props = {'music': '--no-music' not in argv, 'sfx': '--no-sfx' not in argv}
    tl = timeline(pdir)
    ranges = parts(tl)
    pdir_parts = pdir / 'out/parts'
    if '--resume' not in argv:
        shutil.rmtree(pdir_parts, ignore_errors=True)
    pdir_parts.mkdir(parents=True, exist_ok=True)
    print(f"xuất projects/{pdir.name}/out/video.mp4 thành {len(ranges)} phần: nhạc {'có' if props['music'] else 'không'}, sfx {'có' if props['sfx'] else 'không'}")
    files = []
    for i, (a, b) in enumerate(ranges, 1):
        f = pdir_parts / f'{a:06d}-{b:06d}.mp4'
        files.append(f)
        if f.exists():
            print(f'[{i}/{len(ranges)}] khung {a}-{b}: đã có, bỏ qua')
            continue
        print(f'[{i}/{len(ranges)}] khung {a}-{b}')
        tmp = f.with_suffix('.part.mp4')
        r = remotion(['render', str(entry), comp_id(pdir.name), str(tmp), pub, f'--frames={a}-{b}', '--muted',
                      f'--props={json.dumps(props)}'])
        if r.returncode:
            sys.exit(f'phần {i} (khung {a}-{b}) lỗi; sửa xong chạy lại với --resume để giữ các phần đã xong')
        tmp.rename(f)
    concat = pdir_parts / 'concat.txt'
    concat.write_text(''.join(f"file '{f.name}'\n" for f in files))
    silent = pdir_parts / 'video_silent.mp4'
    if subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(concat), '-c', 'copy', str(silent)]).returncode:
        sys.exit('ghép các phần lỗi')
    out = pdir / 'out/video.mp4'
    if mix_audio(pdir, silent, out, props, tl['volume'], sum(b - a + 1 for a, b in ranges) / tl['fps']):
        sys.exit('trộn âm thanh lỗi')
    print(f'xong: {out}')


if __name__ == '__main__':
    main()
