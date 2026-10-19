"""Join per-scene voiceover clips into one clean, levelled narration file.

usage:
  python3 stitch_vo.py --script work/script.json --clips work/vo/scene01.wav work/vo/scene02.wav ... \
      --out work/vo/voiceover.wav [--gap 0.5] [--target-seconds 180] [--lufs -16]

- trims each clip's leading/trailing silence, then joins them with `--gap` seconds of silence
- --target-seconds: gently speeds up / slows down the whole read (allowed 0.87x-1.15x) to hit a length
- levels to --lufs integrated (stereo-equivalent, the way CapCut plays a mono file), peaks kept under -1.5 dBFS
- writes 16-bit mono WAV; if that is over 28 MB (long videos) it also writes an .m4a to deliver instead
- writes work/vo/scenes.json: each scene's start/end inside the final file plus its text (align_vo.py uses it)
"""
import argparse
import os
import subprocess
import numpy as np
import common as C

SR = 48000


def trim(x, head=0.06, tail=0.14, thresh=-45.0):
    hop = SR // 100
    n = len(x) // hop
    db = 20 * np.log10(np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12))
    loud = np.where(db > thresh)[0]
    if not len(loud):
        return x
    a = max(0, loud[0] * hop - int(head * SR))
    b = min(len(x), (loud[-1] + 1) * hop + int(tail * SR))
    return x[a:b]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--script', required=True, help='script.json with {"scenes":[{"n":1,"text":"..."}]}')
    ap.add_argument('--clips', nargs='+', required=True, help='one audio file per scene, in scene order')
    ap.add_argument('--out', required=True)
    ap.add_argument('--scenes-out', help='default: scenes.json next to --out')
    ap.add_argument('--gap', type=float, default=0.5, help='silence between scenes (s)')
    ap.add_argument('--target-seconds', type=float)
    ap.add_argument('--lufs', type=float, default=-16.0)
    a = ap.parse_args()

    script = C.load_json(a.script)
    scenes = script['scenes']
    if len(scenes) != len(a.clips):
        C.die(f'{len(scenes)} scenes in the script but {len(a.clips)} clips given')

    parts, marks, t = [], [], 0.0
    lead = np.zeros(int(0.05 * SR), np.float32)
    parts.append(lead)
    t += len(lead) / SR
    for i, (sc, clip) in enumerate(zip(scenes, a.clips)):
        x = trim(C.decode(clip, SR))
        marks.append((t, t + len(x) / SR))
        parts.append(x)
        t += len(x) / SR
        if i < len(scenes) - 1:
            g = np.zeros(int(a.gap * SR), np.float32)
            parts.append(g)
            t += len(g) / SR
    parts.append(np.zeros(int(0.25 * SR), np.float32))
    y = np.concatenate(parts)
    natural = len(y) / SR

    factor = 1.0
    if a.target_seconds:
        factor = natural / a.target_seconds
        if not 0.87 <= factor <= 1.15:
            print(f'NOTE: natural read is {natural:.1f}s; hitting {a.target_seconds:.0f}s needs {factor:.2f}x, which would '
                  f'sound unnatural. Keeping natural speed. Trim/extend the script or regenerate with speech_rate.')
            factor = 1.0
        elif abs(factor - 1) > 0.005:
            tmp_in, tmp_out = a.out + '.tmp_in.wav', a.out + '.tmp_out.wav'
            C.write_wav(tmp_in, y, SR)
            subprocess.run([C.ffmpeg(), '-v', 'error', '-y', '-i', tmp_in, '-af', f'atempo={factor:.5f}',
                            '-ar', str(SR), tmp_out], check=True)
            y = C.decode(tmp_out, SR)
            os.remove(tmp_in)
            os.remove(tmp_out)

    # level: CapCut plays mono at unity in both channels => stereo-equivalent = mono + 3.01 dB
    cur = C.lufs_integrated(y, SR) + 3.01
    g = 10 ** ((a.lufs - cur) / 20)
    peak = float(np.abs(y).max() * g)
    if peak > 10 ** (-1.5 / 20):          # 1.5 dB headroom so music and effects under the voice don't clip the mix
        g *= 10 ** (-1.5 / 20) / peak
    y = (y * g).astype(np.float32)
    C.write_wav(a.out, y, SR, codec='pcm_s16le')
    if os.path.getsize(a.out) > 28_000_000:
        m4a = os.path.splitext(a.out)[0] + '.m4a'
        subprocess.run([C.ffmpeg(), '-v', 'error', '-y', '-i', a.out, '-c:a', 'aac', '-b:a', '256k', m4a], check=True)
        print(f'NOTE: the WAV is over 28 MB; deliver and reference {m4a} instead (file transfers cap at 30 MB).')

    dur = len(y) / SR
    out_scenes = []
    for sc, (s, e) in zip(scenes, marks):
        out_scenes.append({'n': sc.get('n', len(out_scenes) + 1), 'start': round(s / factor, 3),
                           'end': round(e / factor, 3), 'text': sc['text']})
    so = a.scenes_out or os.path.join(os.path.dirname(os.path.abspath(a.out)), 'scenes.json')
    C.save_json(so, {'voiceover': os.path.abspath(a.out), 'duration': round(dur, 3), 'tempo': round(factor, 4),
                     'scenes': out_scenes})
    words = sum(len(s['text'].split()) for s in scenes)
    print(f'voiceover {dur:.2f}s ({C.mmss(dur)}), natural {natural:.2f}s, tempo x{factor:.3f}, '
          f'{words} words = {words / (dur / 60):.0f} wpm, level {C.lufs_integrated(y, SR) + 3.01:.1f} LUFS')
    print('scenes ->', so)


if __name__ == '__main__':
    main()
