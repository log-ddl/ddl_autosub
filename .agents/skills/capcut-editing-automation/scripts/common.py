"""Shared helpers for the CapCut Editing Automation scripts.

ffmpeg discovery, audio decoding, loudness (ITU-R BS.1770), silence runs,
frame math, JSON io and the time expressions used in edit plans.
"""
import json
import math
import os
import re
import shutil
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(SKILL_DIR, 'assets')


# ------------------------------------------------------------------ io
def load_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def save_json(p, obj, compact=False):
    d = os.path.dirname(os.path.abspath(p))
    os.makedirs(d, exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        if compact:
            f.write(json.dumps(obj, ensure_ascii=False, separators=(',', ':')))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def die(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


# ------------------------------------------------------------------ ffmpeg
_FF = None


def ffmpeg():
    global _FF
    if _FF:
        return _FF
    p = shutil.which('ffmpeg')
    if not p:
        try:
            import imageio_ffmpeg
            p = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            die('ffmpeg not found. Run scripts/check_env.py (it installs imageio-ffmpeg).')
    _FF = p
    return p


def probe(path):
    """(duration_seconds, channels, sample_rate) from ffmpeg's banner (no ffprobe needed)."""
    r = subprocess.run([ffmpeg(), '-hide_banner', '-i', path], capture_output=True)
    err = r.stderr.decode('utf-8', errors='ignore')
    dur = None
    m = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', err)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    ch, sr = 2, 48000
    m = re.search(r'Audio: [^\n]*?(\d+) Hz, ([^,\n]+)', err)
    if m:
        sr = int(m.group(1))
        lay = m.group(2).strip()
        if lay.startswith('mono'):
            ch = 1
        elif lay.startswith('stereo'):
            ch = 2
        else:
            m2 = re.match(r'(\d+) channels', lay)
            ch = int(m2.group(1)) if m2 else 2
    return dur, ch, sr


def decode(path, sr=48000, stereo=False):
    """Decode any audio file to float32 numpy (n,) mono or (n, 2) stereo.

    stereo=True mirrors CapCut playback: a mono file plays at unity in both channels
    (ffmpeg's default upmix would be 3 dB quieter, so we pan explicitly).
    """
    import numpy as np
    if stereo:
        _, ch, _ = probe(path)
        af = ['-af', 'pan=stereo|c0=c0|c1=c0'] if ch == 1 else ['-ac', '2']
        r = subprocess.run([ffmpeg(), '-v', 'error', '-i', path, *af, '-ar', str(sr), '-f', 'f32le', '-'],
                           capture_output=True)
        if r.returncode:
            die(f'could not decode {path}: {r.stderr.decode(errors="ignore")[:300]}')
        return np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()
    r = subprocess.run([ffmpeg(), '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                       capture_output=True)
    if r.returncode:
        die(f'could not decode {path}: {r.stderr.decode(errors="ignore")[:300]}')
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def write_wav(path, x, sr=48000, codec='pcm_s24le'):
    """Write float32 mono/stereo numpy to WAV via ffmpeg (24-bit by default)."""
    import numpy as np
    x = np.asarray(x, dtype=np.float32)
    ch = 1 if x.ndim == 1 else x.shape[1]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    p = subprocess.run([ffmpeg(), '-v', 'error', '-y', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-',
                        '-c:a', codec, path], input=x.tobytes(), capture_output=True)
    if p.returncode:
        die(p.stderr.decode(errors='ignore')[:300])


# ------------------------------------------------------------------ loudness (BS.1770 K-weighting)
def _biquads(fs):
    G, Q1, f1 = 3.99984385397, 0.7071752369554193, 1681.974450955533
    A = 10 ** (G / 40)
    w0 = 2 * math.pi * f1 / fs
    al = math.sin(w0) / (2 * Q1)
    c = math.cos(w0)
    b = [A * ((A + 1) + (A - 1) * c + 2 * math.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c),
         A * ((A + 1) + (A - 1) * c - 2 * math.sqrt(A) * al)]
    a = [(A + 1) - (A - 1) * c + 2 * math.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c),
         (A + 1) - (A - 1) * c - 2 * math.sqrt(A) * al]
    Q2, f2 = 0.5003270373253953, 38.13547087613982
    w0 = 2 * math.pi * f2 / fs
    al = math.sin(w0) / (2 * Q2)
    c = math.cos(w0)
    b2 = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
    a2 = [1 + al, -2 * c, 1 - al]
    return (b, a), (b2, a2)


def k_weight(x, fs):
    from scipy.signal import lfilter
    (b, a), (b2, a2) = _biquads(fs)
    return lfilter(b2, a2, lfilter(b, a, x, axis=0), axis=0)


def _ms(x):
    """per-sample power summed over channels"""
    import numpy as np
    return (x ** 2) if x.ndim == 1 else (x ** 2).sum(axis=1)


def lufs_integrated(x, fs):
    import numpy as np
    p = _ms(k_weight(x, fs))
    blk, hop = int(0.4 * fs), int(0.1 * fs)
    if len(p) < blk:
        return -70.0
    cs = np.concatenate([[0.0], np.cumsum(p)])
    starts = np.arange(0, len(p) - blk + 1, hop)
    z = (cs[starts + blk] - cs[starts]) / blk
    l = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[l > -70]
    if not len(z):
        return -70.0
    rel = -0.691 + 10 * np.log10(z.mean()) - 10
    l = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[l > rel]
    return float(-0.691 + 10 * np.log10(z.mean() + 1e-12))


def short_term_curve(x, fs, win=3.0, hop=0.5):
    """[(t_center, LUFS short-term)] every `hop` seconds."""
    import numpy as np
    p = _ms(k_weight(x, fs))
    n = int(win * fs)
    cs = np.concatenate([[0.0], np.cumsum(p)])
    out = []
    t = 0.0
    total = len(p) / fs
    while t <= total:
        c = int(t * fs)
        a, b = max(0, c - n // 2), min(len(p), c + n // 2)
        z = (cs[b] - cs[a]) / max(1, b - a)
        out.append((round(t, 3), float(max(-70.0, -0.691 + 10 * np.log10(z + 1e-12)))))
        t += hop
    return out


def st200(x, fs):
    """200 ms short-term level curve in dBFS (mono, unweighted). Used for SFX vs VO levels."""
    import numpy as np
    hop = max(1, fs // 100)
    n = max(1, len(x) // hop)
    rms = np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    return 10 * np.log10(np.convolve(rms ** 2, np.ones(20) / 20, mode='same') + 1e-12)


def silence_runs(x, fs, thresh_db=-40.0, min_len=0.12):
    """[(start, end)] where the 10 ms level stays below thresh_db for at least min_len seconds."""
    import numpy as np
    hop = fs // 100
    n = len(x) // hop
    rms = np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    quiet = db < thresh_db
    runs, i = [], 0
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if (j - i) * 0.01 >= min_len:
                runs.append((round(i * 0.01, 3), round(j * 0.01, 3)))
            i = j
        else:
            i += 1
    return runs


# ------------------------------------------------------------------ frames / time
def fr(t, fps):
    return int(round(t * fps))


def us(frames, fps):
    return int(frames * 1000000 // fps)


def fsnap(t, fps):
    return round(t * fps) / fps


def mmss(t):
    t = round(float(t), 1)
    return f"{int(t // 60)}:{t % 60:04.1f}"


_TX = re.compile(r'^\s*([wecs])(\d+)\s*(?:([+-])\s*(\d*\.?\d+))?\s*$')


def resolve_time(x, words=None, cuts=None, end=None):
    """Numbers are seconds. Strings:
      'w12'  start of word 12 (silence-corrected)   'e12' end of word 12
      'c5'   start (cut) of shot 5                    's5'  same as c5
      'end'  end of the timeline
    Any of them may carry an offset: 'w12+0.05', 'c5-0.1'.
    """
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    s = str(x).strip()
    if s == 'end':
        if end is None:
            die("'end' used before the timeline end is known")
        return float(end)
    m = _TX.match(s)
    if not m:
        try:
            return float(s)
        except ValueError:
            die(f'bad time expression: {x!r}')
    kind, i, sign, off = m.group(1), int(m.group(2)), m.group(3), m.group(4)
    if kind in 'we':
        if words is None or i >= len(words):
            die(f'word index out of range in {x!r}')
        base = words[i]['s'] if kind == 'w' else words[i]['e']
    else:
        if cuts is None or i not in cuts:
            die(f'shot number not found in {x!r}')
        base = cuts[i]
    if off:
        base += float(off) * (1 if sign == '+' else -1)
    return float(base)
