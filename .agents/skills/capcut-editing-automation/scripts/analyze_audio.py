"""Measure sound effects and music so they can be placed and levelled precisely.

usage:
  python3 analyze_audio.py FILE [FILE ...]          # sound effects: length, onset, peak, tail end, level
  python3 analyze_audio.py --music FILE [FILE ...]  # music: length, loudness, strong hits near the end (for landing the
                                                    # final chord on a word), quiet spots
Results are cached in work/audio_cache.json (path set by --cache) and reused by build_capcut.py.

Field meanings (seconds into the file):
  onset_t  where the sound actually starts (skip leading silence by starting the clip here)
  peak_t   loudest moment (align this to a word with align="peak", e.g. a stamp or a thud)
  end_t    where the useful sound has died away
  st_max   loudest 200 ms level (dBFS) - build_capcut.py levels effects with it
"""
import argparse
import os
import numpy as np
import common as C

SR = 16000


class Cache:
    def __init__(self, path):
        self.path = path
        self.d = C.load_json(path) if path and os.path.exists(path) else {}
        self.dirty = False

    def key(self, p):
        st = os.stat(p)
        return f'{os.path.abspath(p)}|{st.st_size}|{int(st.st_mtime)}'

    def get(self, p, kind):
        return self.d.get(self.key(p) + '|' + kind)

    def put(self, p, kind, v):
        self.d[self.key(p) + '|' + kind] = v
        self.dirty = True

    def save(self):
        if self.dirty and self.path:
            C.save_json(self.path, self.d)


_decoded = {}


def mono(p):
    if p not in _decoded:
        _decoded[p] = C.decode(p, SR)
    return _decoded[p]


def analyze_sfx(p, cache=None):
    if cache:
        v = cache.get(p, 'sfx')
        if v:
            return v
    x = mono(p)
    dur = len(x) / SR
    hop = SR // 100
    n = max(1, len(x) // hop)
    db = 20 * np.log10(np.sqrt(np.mean(x[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12))
    pk = float(db.max())
    on = np.where((db > pk - 25) & (db > -55))[0]
    onset = float(on[0] * 0.01) if len(on) else 0.0
    peak = float(np.argmax(db) * 0.01)
    tail = np.where(db > max(-60.0, pk - 35))[0]
    end = float(min(dur, (tail[-1] + 1) * 0.01)) if len(tail) else dur
    st = C.st200(x, SR)
    v = {'dur': round(dur, 3), 'onset_t': round(onset, 3), 'peak_t': round(peak, 3), 'end_t': round(end, 3),
         'st_max': round(float(st.max()), 2), 'peak_db': round(float(20 * np.log10(np.abs(x).max() + 1e-9)), 2)}
    if cache:
        cache.put(p, 'sfx', v)
    return v


def seg_levels(p, src, dur):
    """(200 ms short-term max, sample peak) of the part of the file that is actually used"""
    x = mono(p)[int(src * SR):int((src + dur) * SR)]
    if len(x) < SR // 50:
        return -60.0, -60.0
    return float(C.st200(x, SR).max()), float(20 * np.log10(np.abs(x).max() + 1e-9))


def analyze_music(p, cache=None):
    if cache:
        v = cache.get(p, 'music')
        if v:
            return v
    x = C.decode(p, 48000, stereo=True)
    dur = len(x) / 48000
    curve = C.short_term_curve(x, 48000, 3.0, 0.5)
    integ = C.lufs_integrated(x, 48000)
    m = x.mean(axis=1)[::3]   # 16 kHz-ish envelope for hit detection
    fs = 16000
    hop = fs // 20
    n = len(m) // hop
    db = 20 * np.log10(np.sqrt(np.mean(m[:n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12))
    rise = np.diff(db, prepend=db[0])
    hits = []
    lo = max(0, n - int(30 / 0.05))
    order = np.argsort(-rise[lo:]) + lo
    for i in order:
        t = i * 0.05
        if rise[i] < 6:
            break
        if all(abs(t - h['t']) > 1.0 for h in hits):
            hits.append({'t': round(float(t), 2), 'jump_db': round(float(rise[i]), 1), 'level_db': round(float(db[i]), 1)})
        if len(hits) >= 6:
            break
    hits.sort(key=lambda h: h['t'])
    loud = np.where(db > db.max() - 40)[0]
    sound_end = float((loud[-1] + 1) * 0.05) if len(loud) else dur
    v = {'dur': round(dur, 3), 'lufs': round(integ, 1), 'curve': curve, 'hits_last_30s': hits,
         'sound_end': round(sound_end, 2)}
    if cache:
        cache.put(p, 'music', v)
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('files', nargs='+')
    ap.add_argument('--music', action='store_true')
    ap.add_argument('--cache', default='work/audio_cache.json')
    a = ap.parse_args()
    cache = Cache(a.cache)
    for p in a.files:
        if not os.path.exists(p):
            print('missing:', p)
            continue
        if a.music:
            v = analyze_music(p, cache)
            print(f"{os.path.basename(p)}: {v['dur']:.1f}s, {v['lufs']} LUFS, sound ends {v['sound_end']}s, "
                  f"strong hits in the last 30 s: {[h['t'] for h in v['hits_last_30s']]}")
        else:
            v = analyze_sfx(p, cache)
            print(f"{os.path.basename(p)}: dur {v['dur']}s onset {v['onset_t']} peak {v['peak_t']} end {v['end_t']} "
                  f"st_max {v['st_max']} dBFS")
    cache.save()


if __name__ == '__main__':
    main()
