"""Time every shot of the shot list against the voiceover.

usage: python3 plan_shots.py --shots work/shotlist.json --words work/timing/words.json --scenes work/vo/scenes.json \
           --out work/timing/shots_timed.json [--fps 30] [--tail 0.4]

shotlist.json (written by Claude, approved by the viewer):
  [{"n": 1, "text": "In 1932, Australia sent soldiers ...", "visual": "...", "chars": ["soldier"], "onscreen": "1932"}, ...]
  The shots' "text" fields, joined in order, must be exactly the script (every word once, in order).

Cut rule: each cut sits in the pause right before the shot's first word, 0.05 s before speech resumes,
snapped to whole frames, so the picture changes a frame or two before the line starts. Shot 1 starts at 0
and the last shot holds until the end of the voiceover plus --tail seconds.
Writes shots_timed.json and shots_table.md (paste-ready table for the viewer).
"""
import argparse
import os
import re
import common as C


def norm(t):
    return re.sub(r'[^a-z0-9]', '', t.lower())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', required=True)
    ap.add_argument('--words', required=True)
    ap.add_argument('--scenes', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--tail', type=float, default=0.4)
    a = ap.parse_args()

    shots = C.load_json(a.shots)
    words = C.load_json(a.words)
    meta = C.load_json(a.scenes)
    runs = C.load_json(os.path.join(os.path.dirname(os.path.abspath(a.words)), 'silences.json'))
    vo_dur = meta['duration']
    fps = a.fps

    # map shot texts onto the script's word sequence
    wi = 0
    firsts = []
    for sh in shots:
        toks = [t for t in sh['text'].split() if norm(t)]
        if not toks:
            C.die(f"shot {sh['n']} has no narration text")
        firsts.append(wi)
        for t in toks:
            while wi < len(words) and not norm(words[wi]['w']):
                wi += 1
            if wi >= len(words):
                C.die(f"shot {sh['n']}: ran past the end of the script at {t!r}")
            if norm(words[wi]['w']) != norm(t):
                ctx = ' '.join(w['w'] for w in words[max(0, wi - 3):wi + 4])
                C.die(f"shot {sh['n']}: expected {words[wi]['w']!r} (word {wi}) but the shot text has {t!r}. "
                      f"Script around there: ...{ctx}...")
            wi += 1
    if wi != len(words):
        C.die(f'the shot list stops at word {wi} of {len(words)}: '
              f'"{" ".join(w["w"] for w in words[wi:wi + 8])} ..." is not covered')

    end = C.fsnap(vo_dur + a.tail, fps)
    cuts = [0.0]
    for k in range(1, len(shots)):
        t = words[firsts[k]]['s']
        cand = [(r0, r1) for r0, r1 in runs if t - 0.6 <= r1 <= t + 0.05]
        if cand:
            r0, r1 = max(cand, key=lambda r: r[1])
            c = max(r0, r1 - 0.05)
        else:
            c = t - 0.04
        c = C.fsnap(c, fps)
        if c <= cuts[-1]:
            c = cuts[-1] + 1.0 / fps
        cuts.append(round(c, 4))
    out, warn = [], []
    for k, sh in enumerate(shots):
        s = cuts[k]
        e = cuts[k + 1] if k + 1 < len(shots) else end
        last = (firsts[k + 1] - 1) if k + 1 < len(shots) else len(words) - 1
        d = round(e - s, 3)
        row = dict(sh)
        row.update({'start': s, 'end': round(e, 4), 'dur': d, 'first_word': firsts[k], 'last_word': last})
        out.append(row)
        if d < 1.2:
            warn.append(f"shot {sh['n']} is only {d:.2f}s (consider merging it with a neighbour)")
        if d > 7.5:
            warn.append(f"shot {sh['n']} runs {d:.1f}s (consider splitting it into two images)")
    C.save_json(a.out, {'fps': fps, 'end': end, 'vo_duration': vo_dur, 'shots': out})

    md = [f'| # | Start | End | Sec | Voiceover | Visual | On-screen |', '| --- | --- | --- | --- | --- | --- | --- |']
    for r in out:
        md.append(f"| {r['n']} | {C.mmss(r['start'])} | {C.mmss(r['end'])} | {r['dur']:.1f} | {r['text']} | "
                  f"{r.get('visual', '')} | {r.get('onscreen', '') or ''} |")
    with open(os.path.join(os.path.dirname(os.path.abspath(a.out)), 'shots_table.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(md) + '\n')
    durs = [r['dur'] for r in out]
    print(f'{len(out)} shots over {C.mmss(end)}; shortest {min(durs):.2f}s, longest {max(durs):.2f}s, '
          f'average {sum(durs) / len(durs):.2f}s -> {a.out}')
    for w in warn:
        print('NOTE:', w)


if __name__ == '__main__':
    main()
