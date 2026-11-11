#!/usr/bin/env python3
"""Nhạc nền tổng hợp (placeholder): pad trầm, ostinato bass, trống trầm ở mốc, hi-hat căng, riser trước cao trào,
gió/sóng nền. Mặc định bám mốc voice hook Black Buck (war_20, 0–42.6 s); đoạn khác truyền --cues file.json:
{"pad": 5.8, "hits": [[t, p], ...], "bass": [[a, b, mức], ...], "hats": [a, b], "riser": [a, b], "root": 38}
Chỉ cần numpy.

    python3 core/tools/synth_music.py <out.wav> [--dur 42.6] [--cues cues.json]
"""
import json
import sys
import wave

try:
    import numpy as np
except ImportError:
    sys.exit('Thiếu numpy. Chạy bằng .venv/bin/python (cài: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)')

SR = 44100
args = [a for a in sys.argv[1:] if not a.startswith('--')]
OUT = args[0]
DUR = float(sys.argv[sys.argv.index('--dur') + 1]) if '--dur' in sys.argv else 42.6
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(3)
BEAT = 60 / 96
CUES = {'pad': 5.8, 'hits': [[3.5, 0.9], [5.82, 0.8], [11.86, 0.6], [17.42, 0.7], [23.38, 0.9], [35.28, 1.0], [39.46, 0.8]],
        'bass': [[11.86, 17.4, 0.6], [23.38, 35.4, 1.0], [36.5, DUR, 0.5]], 'hats': [23.38, 35.28], 'riser': [31.8, 35.28], 'root': 38}
if '--cues' in sys.argv:
    CUES.update(json.load(open(sys.argv[sys.argv.index('--cues') + 1])))


def env(a, b, fi=0.5, fo=0.5):
    """Bao biên độ: lên trong fi giây từ a, xuống trong fo giây tới b."""
    e = np.clip((t - a) / max(fi, 1e-3), 0, 1) * np.clip((b - t) / max(fo, 1e-3), 0, 1)
    return e * e * (3 - 2 * e)


def lp(x, fc):
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** 4), len(x))


def saw(f, detune=0.0):
    ph = (t * f * (1 + detune)) % 1
    return 2 * ph - 1


def note(n):
    return 440 * 2 ** ((n - 69) / 12)


mix = np.zeros(N)

# 1. drone D2 + A2, phồng dần
R0 = CUES['root']
drone = sum(saw(note(m), d) for m in (R0, R0 + 7) for d in (-0.003, 0.0, 0.004))
mix += lp(drone, 380) * 0.05 * env(0, DUR, 2.5, 2.0) * (0.7 + 0.3 * np.sin(t * 0.4))

# 2. vòng hợp âm pad từ 5.8 s: Dm Bb F C (mỗi hợp âm 2 ô nhịp)
chords = [tuple(n + R0 - 38 for n in c) for c in [(50, 53, 57), (46, 50, 53), (53, 57, 60), (48, 52, 55)]]
bar = BEAT * 4
pad = np.zeros(N)
for k in range(200):
    a = CUES['pad'] + k * bar * 2
    if a > DUR:
        break
    seg = env(a - 0.2, a + bar * 2 + 0.3, 0.6, 0.6)
    for m in chords[k % 4]:
        pad += (saw(note(m), -0.004) + saw(note(m), 0.004)) * seg
mix += lp(pad, 900) * 0.022 * env(CUES['pad'] - 0.2, DUR, 1.5, 2.5)

# 3. ostinato bass móc 8 (D) từ 11.86, căng nhất ở đoạn tiếp sức 23.4–35.3
bass = np.zeros(N)
roots = [R0, R0 - 4, R0 + 3, R0 - 2]
B0 = min(b[0] for b in CUES['bass'])
for i in range(int((DUR - B0) / (BEAT / 2))):
    a = B0 + i * BEAT / 2
    r = roots[int(max(0, a - CUES['pad']) // (bar * 2)) % 4]
    idx = (t >= a) & (t < a + BEAT / 2)
    tt = t[idx] - a
    bass[idx] += np.sin(2 * np.pi * note(r) * tt) * np.exp(-tt * 9) + 0.4 * np.sign(np.sin(2 * np.pi * note(r) * tt)) * np.exp(-tt * 14)
mix += lp(bass, 700) * 0.09 * sum(env(a, min(b, DUR), 0.8, 0.4) * lv for a, b, lv in CUES['bass'])

# 4. hi-hat 16 nốt căng ở đoạn tiếp sức
hat = np.zeros(N)
H0, H1 = CUES['hats']
for i in range(int((H1 - H0) / (BEAT / 4))):
    a = H0 + i * BEAT / 4
    idx = (t >= a) & (t < a + 0.06)
    hat[idx] += rng.standard_normal(idx.sum()) * np.exp(-(t[idx] - a) * 60) * (1.0 if i % 4 == 2 else 0.45)
hat = hat - lp(hat, 6000)
mix += hat * 0.05 * np.clip((t - H0) / 8, 0, 1)

# 5. trống trầm (taiko giả) ở mốc
for a, p in CUES['hits']:
    idx = (t >= a) & (t < a + 1.6)
    tt = t[idx] - a
    f = 55 * (1 + 1.6 * np.exp(-tt * 22))
    mix[idx] += p * 0.32 * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 3.2)
    mix[idx] += p * 0.06 * rng.standard_normal(idx.sum()) * np.exp(-tt * 30)

# 6. riser trước cao trào 35.28
RA, RB = CUES['riser']
r = env(RA, RB, RB - RA - 0.02, 0.02)
noise = rng.standard_normal(N)
mix += (noise - lp(noise, 1200)) * 0.05 * r ** 2
mix += np.sin(2 * np.pi * np.cumsum(220 + 660 * np.clip((t - RA) / (RB - RA), 0, 1) ** 2) / SR) * 0.02 * r

# 7. nền gió/biển rất nhỏ
wind = lp(rng.standard_normal(N), 500)
mix += wind * 0.018 * (0.6 + 0.4 * np.sin(t * 0.7))

# lấy lại mức, mềm đầu cuối
mix *= env(0, DUR, 0.3, 1.8) + 1e-9
mix = np.tanh(mix * 1.6) / 1.6
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.5
with wave.open(OUT, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype(np.int16).tobytes())
print(OUT, f'{DUR}s')
