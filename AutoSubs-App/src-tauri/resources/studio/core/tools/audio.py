#!/usr/bin/env python3
"""Trộn âm thanh cho một dự án → .build/public/{voice.mp3, music.wav, sfx.wav}.

    .venv/bin/python core/tools/audio.py <id>

plan/mix.json
    {"volume": {"voice": 1.0, "music": 0.4, "sfx": 0.5}, "music": [...]}
    music: [{"asset": "a040", "from": 0, "to": 120, "in": 0, "fadeIn": 1, "fadeOut": 2, "volume": 1.0, "duck": 0.5}]
        from/to = giây trên video (to bỏ trống = hết file), in = giây bắt đầu trong file,
        duck = hạ đoạn nhạc này bao nhiêu khi có voice (0..1, mặc định 0).
      hoặc [{"synth": {"pad": 2.0, "root": 38, "hits": [[t, p]], "bass": [[a, b, mức]], "hats": [a, b], "riser": [a, b]}}]
        nhạc tổng hợp tạm (core/tools/synth_music.py).
plan/chapters/CNN.json "sfx": mỗi tiếng một trong hai dạng
    {"at": 14.2, "asset": "a050", "volume": 0.8, "trim": [0, 1.5]}       file trong assets/
    {"at": 14.2, "synth": "cannon", "power": 0.8}                        tổng hợp (core/tools/synth_sfx.py)
Cần numpy, ffmpeg.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit('Thiếu numpy. Chạy bằng .venv/bin/python')

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth_sfx as snd  # noqa: E402
from common import assets, link_file, load, need, timeline  # noqa: E402

SR = snd.SR


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype='<f4').astype(np.float64)


def asset_file(pdir: Path, reg: dict, i: str) -> Path:
    a = reg.get(i)
    f = pdir / 'assets' / a['file'] if a and a.get('file') else None
    if not f or not f.is_file():
        sys.exit(f'tài sản {i} chưa có file (assets/ASSETS.json)')
    return f


def voice_env(voice: np.ndarray, n: int) -> np.ndarray:
    """Đường bao voice 0..1 (mượt ~0.3 s) để hạ nhạc khi có lời."""
    hop = SR // 20
    k = len(voice) // hop
    if k == 0:
        return np.zeros(n)
    rms = np.sqrt(np.mean(voice[:k * hop].reshape(k, hop) ** 2, axis=1))
    on = (rms > max(0.01, 0.15 * np.percentile(rms, 90))).astype(float)
    on = np.convolve(on, np.ones(7) / 7, mode='same')
    return np.clip(np.interp(np.arange(n) / SR, np.arange(k) * hop / SR, on), 0, 1)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    pdir = need(sys.argv[1])
    tl, reg = timeline(pdir), assets(pdir)
    mix = load(pdir / 'plan/mix.json')
    vol = {'voice': 1.0, 'music': 0.4, 'sfx': 0.5} | mix.get('volume', {})
    dur = tl['duration']
    n = int(SR * dur)
    pub = pdir / '.build/public'
    pub.mkdir(parents=True, exist_ok=True)

    voice_f = pdir / 'assets/voice/voice.mp3'
    voice = decode(voice_f) if voice_f.is_file() else np.zeros(n)
    if voice_f.is_file():
        if abs(vol['voice'] - 1.0) < 1e-6:
            link_file(voice_f, pub / 'voice.mp3')
        else:
            subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(voice_f), '-af', f"volume={vol['voice']}",
                            '-c:a', 'libmp3lame', '-q:a', '2', str(pub / 'voice.mp3')], check=True)

    # Nhạc
    music = np.zeros(n)
    for m in mix.get('music', []):
        if 'synth' in m:
            with tempfile.TemporaryDirectory() as td:
                cj, wav = Path(td) / 'c.json', Path(td) / 'm.wav'
                cj.write_text(json.dumps(m['synth']))
                subprocess.run([sys.executable, str(Path(__file__).with_name('synth_music.py')), str(wav), '--dur', f'{dur:.2f}', '--cues', str(cj)],
                               check=True, capture_output=True)
                x = decode(wav)
            music[:min(n, len(x))] += x[:n] * m.get('volume', 1.0)
            print('    nhạc tổng hợp')
            continue
        x = decode(asset_file(pdir, reg, m['asset']))
        a = int(m.get('in', 0) * SR)
        span = int((m['to'] - m.get('from', 0)) * SR) if 'to' in m else len(x) - a
        x = x[a:a + span].copy()
        for key, sl in (('fadeIn', slice(None)), ('fadeOut', slice(None, None, -1))):
            fd = int(m.get(key, 1.0) * SR)
            if fd and len(x) > 2 * fd:
                x[sl][:fd] *= np.linspace(0, 1, fd)
        seg = np.zeros(n)
        snd.place(seg, x * m.get('volume', 1.0), m.get('from', 0))
        if m.get('duck'):
            seg *= 1 - m['duck'] * voice_env(voice, n)
        music += seg
        print(f"    nhạc {m['asset']}  {m.get('from', 0):.2f}s")
    snd.write_track(pub / 'music.wav', music, f"{len(mix.get('music', []))} đoạn nhạc")

    # SFX của mọi chương
    buf = np.zeros(n)
    cues = sorted(tl['sfx'], key=lambda c: c['at'])
    for c in cues:
        if 'asset' in c:
            x = decode(asset_file(pdir, reg, c['asset']))
            if 'trim' in c:
                x = x[int(c['trim'][0] * SR):int(c['trim'][1] * SR)]
            kind = c['asset']
        else:
            fn = snd.SFX.get(c.get('synth'))
            if not fn:
                sys.exit(f"sfx tổng hợp không có: {c.get('synth')} (có: {', '.join(sorted(snd.SFX))})")
            x = fn(**{k: v for k, v in c.items() if k not in ('at', 'synth', 'volume')})
            kind = c['synth']
        snd.place(buf, x * c.get('volume', 1.0), float(c['at']))
        print(f"    {c['at']:7.2f}s  {kind}")
    snd.write_track(pub / 'sfx.wav', buf, f'{len(cues)} tiếng')
    print(f'projects/{pdir.name}/.build/public: voice.mp3, music.wav, sfx.wav ({dur:.2f}s)')


if __name__ == '__main__':
    main()
