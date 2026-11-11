#!/usr/bin/env python3
"""Bộ tổng hợp tiếng động (SFX) bằng numpy. Là module, dùng qua core/tools/audio.py.

Loại: cannon mg burst rocket boom whoosh tick chime thud whir prop. Mỗi hàm trả mảng mono 44.1 kHz.
Trong "sfx" của plan/chapters/CNN.json: {"at": 3.7, "synth": "cannon", "power": 0.8}. File thật thì {"at": 3.7, "asset": "a050"}.
"""
import sys
import wave
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit('Thiếu numpy. Chạy bằng .venv/bin/python (cài: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)')

SR = 44100
ROOT = Path(__file__).resolve().parents[2]
RNG = np.random.default_rng(7)


# ---------------------------------------------------------------- lọc (FFT, không cần scipy)
def _filt(x, fn):
    n = len(x)
    if n < 8:
        return x
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    return np.fft.irfft(X * fn(f), n)


def lp(x, fc, order=2):
    return _filt(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def hp(x, fc, order=2):
    return _filt(x, lambda f: (f / fc) ** order / np.sqrt(1 + (f / fc) ** (2 * order)))


def bp(x, lo, hi):
    return lp(hp(x, lo), hi)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def noise(dur):
    return RNG.uniform(-1, 1, int(dur * SR))


def sweep(f0, f1, dur, curve=1.0):
    t = tt(dur)
    p = (t / max(dur, 1e-6)) ** curve
    f = f0 + (f1 - f0) * p
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


# ---------------------------------------------------------------- tiếng bắn và tiếng nổ
def boom(power=1.0, size=1.0, **_):
    d = 1.3 + 0.9 * size
    t = tt(d)
    body = lp(noise(d), 160 + 60 * size) * np.exp(-t * 2.6 / size) * 3.2
    sub = sweep(95, 30, d, 0.4) * np.exp(-t * 2.2) * 1.2
    crack = hp(noise(d), 1800) * np.exp(-t * 45) * 0.6
    return (body + sub + crack) * power


def cannon(power=1.0, **_):
    d = 1.4
    t = tt(d)
    snap = hp(noise(d), 900) * np.exp(-t * 70) * 1.1
    body = lp(noise(d), 380) * np.exp(-t * 5.5) * 2.2
    sub = sweep(140, 38, d, 0.3) * np.exp(-t * 3.2)
    return (snap + body + sub) * power


def rocket(power=0.8, dur=1.2, **_):
    t = tt(dur)
    e = np.minimum(1, t / 0.03) * np.exp(-t * 1.4)
    roar = bp(noise(dur), 250, 3200) * 2.0
    whine = sweep(300, 900, dur) * 0.25
    return (roar + whine) * e * power


def burst(power=0.7, count=6, rate=12.0, **_):
    out = np.zeros(int((count / rate + 1.5) * SR))
    for i in range(int(count)):
        s = cannon(power * RNG.uniform(0.45, 0.6))
        j = int((i / rate + RNG.uniform(0, 0.008)) * SR)
        out[j:j + len(s)] += s[: len(out) - j]
    return out


def mg(power=0.5, dur=1.2, rate=14.0, **_):
    out = np.zeros(int((dur + 0.5) * SR))
    k = 0.0
    while k < dur:
        d = 0.12
        s = (hp(noise(d), 700) * np.exp(-tt(d) * 60) + lp(noise(d), 500) * np.exp(-tt(d) * 25)) * power * RNG.uniform(0.6, 1)
        i = int(k * SR)
        out[i:i + len(s)] += s
        k += 1 / rate
    return out


# ---------------------------------------------------------------- tiếng nhẹ: chuyển cảnh, đo đếm, cánh quạt (dùng khi phim không có bắn/nổ)
def whoosh(power=0.5, dur=0.6, **_):
    t = tt(dur)
    e = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    return bp(noise(dur), 300, 2600) * e * power * 1.6


def tick(power=0.5, **_):
    d = 0.09
    t = tt(d)
    return (hp(noise(d), 2500) * np.exp(-t * 90) * 0.8 + sweep(1900, 1500, d) * np.exp(-t * 60) * 0.5) * power


def chime(power=0.5, f=880.0, **_):
    d = 0.9
    t = tt(d)
    return (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.01 * t)) * np.exp(-t * 6) * power * 0.7


def thud(power=0.6, **_):
    d = 0.5
    t = tt(d)
    return (sweep(120, 45, d, 0.4) * np.exp(-t * 11) * 1.4 + lp(noise(d), 300) * np.exp(-t * 25)) * power


def whir(power=0.35, dur=1.5, f=190.0, **_):
    t = tt(dur)
    e = np.minimum(1, t / 0.15) * np.minimum(1, (dur - t) / 0.25)
    w = sum(np.sin(2 * np.pi * f * k * t + k) / k for k in (1, 2, 3, 4)) * (1 + 0.25 * np.sin(2 * np.pi * 9 * t))
    return (w * 0.5 + lp(noise(dur), 1800) * 0.25) * e * power


def prop(power=0.3, dur=2.0, **_):
    """cánh quạt máy bay cỡ lớn: trầm, đều"""
    t = tt(dur)
    e = np.minimum(1, t / 0.4) * np.minimum(1, (dur - t) / 0.5)
    return (lp(noise(dur), 420) * 1.4 + sweep(70, 70, dur) * 0.5) * e * power


SFX = dict(cannon=cannon, mg=mg, burst=burst, rocket=rocket, boom=boom,
           whoosh=whoosh, tick=tick, chime=chime, thud=thud, whir=whir, prop=prop)


# ---------------------------------------------------------------- tiện ích
def place(buf, x, t0):
    i = int(t0 * SR)
    if i >= len(buf) or len(x) == 0:
        return
    if i < 0:
        x, i = x[-i:], 0
    m = min(len(x), len(buf) - i)
    buf[i:i + m] += x[:m]


def write_track(path, x, label):
    peak = float(np.max(np.abs(x))) if len(x) else 0
    y = np.tanh(x * 0.9) / np.tanh(0.9) if peak > 0.9 else x
    y = np.clip(y, -1, 1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((y * 32767).astype('<i2').tobytes())
    print(f'  {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}: {label}, đỉnh {peak:.2f}')

