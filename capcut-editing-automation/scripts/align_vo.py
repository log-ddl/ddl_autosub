"""Word-level timing for the voiceover, indexed by the SCRIPT's own words.

usage: python3 align_vo.py --scenes work/vo/scenes.json --out work/timing/words.json [--method auto|whisper|pauses] [--names "Meredith, Lewis"]

Writes:
  words.json     [{"i","w","s","e","scene","sent"}]  s/e in seconds; 's' is silence-corrected
  silences.json  [[start, end], ...]  pauses >= 120 ms in the voiceover
  words.txt      one line per sentence: w26@7.02 This  w27@7.21 is ...   (look up word indexes here)

Method:
  whisper  faster-whisper small.en word timestamps matched back to the script words (best; needs the model download)
  pauses   no model: the read is generated scene by scene from known text, so each scene's words are spread
           over its speech by syllable weight and pinned to the pauses at punctuation. Accurate to about 0.1-0.2 s.
  auto     whisper if it loads, otherwise pauses.
Word starts are then corrected against the pauses (TTS word onsets from whisper run early).
"""
import argparse
import difflib
import math
import os
import re
import numpy as np
import common as C

SR = 16000
STRONG = re.compile(r'[.?!;:]["\')\]]*$')
WEAK = re.compile(r'[,—–-]["\')\]]*$')


def norm(t):
    return re.sub(r'[^a-z0-9]', '', t.lower())


_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
         'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']


def _num_words(n):
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ('' if n % 10 == 0 else ' ' + _ONES[n % 10])
    if n < 1000:
        return _ONES[n // 100] + ' hundred' + ('' if n % 100 == 0 else ' and ' + _num_words(n % 100))
    for div, name in ((10 ** 9, 'billion'), (10 ** 6, 'million'), (1000, 'thousand')):
        if n >= div:
            return _num_words(n // div) + ' ' + name + ('' if n % div == 0 else ' ' + _num_words(n % div))
    return ''


def spoken(tok):
    """rough spoken form of a token (numbers, years, ordinals, %, $) for syllable counting"""
    t = tok.lower()
    m = re.match(r'^[^0-9]*?(\$)?([0-9][0-9,]*)(?:\.([0-9]+))?(st|nd|rd|th|s|%|k|m)?', t)
    if not m or not re.search(r'[0-9]', t):
        return t
    raw = m.group(2).rstrip(',')
    cur, whole, dec, suf = m.group(1), raw.replace(',', ''), m.group(3), m.group(4)
    n = int(whole) if whole else 0
    if len(whole) == 4 and 1100 <= n <= 2099 and ',' not in raw and not cur and not (2000 <= n <= 2009):
        words = _num_words(n // 100) + ' ' + (_num_words(n % 100) if n % 100 else 'hundred')   # 1932 -> nineteen thirty two
    else:
        words = _num_words(min(n, 10 ** 12 - 1))
    if dec:
        words += ' point ' + ' '.join(_ONES[int(c)] for c in dec)
    if suf == '%':
        words += ' percent'
    elif suf == 'k':
        words += ' thousand'
    elif suf == 'm':
        words += ' million'
    elif suf in ('st', 'nd', 'rd', 'th'):
        words += 'th'
    if cur:
        words += ' dollars'
    return words


def syllables(tok):
    w = spoken(tok)
    total = 0.0
    for part in re.findall(r'[a-z]+', w):
        n = len(re.findall(r'[aeiouy]+', part))
        if part.endswith('e') and n > 1 and not part.endswith('le'):
            n -= 1
        total += max(1, n)
    return max(0.3, total)


def tokens_from_scenes(scenes):
    toks, sent = [], 0
    for sc in scenes:
        for raw in sc['text'].split():
            toks.append({'w': raw, 'scene': sc['n'], 'sent': sent})
            if STRONG.search(raw):
                sent += 1
        if toks and not STRONG.search(toks[-1]['w']):
            sent += 1
    return toks


# ------------------------------------------------------------------ whisper
def whisper_words(vo_path, names):
    from faster_whisper import WhisperModel
    m = WhisperModel('small.en', device='cpu', compute_type='int8')
    x = C.decode(vo_path, SR)
    segs, _ = m.transcribe(x, word_timestamps=True, beam_size=5, vad_filter=False,
                           initial_prompt=names or None)
    out = []
    for s in segs:
        for w in s.words:
            out.append({'w': w.word.strip(), 's': float(w.start), 'e': float(w.end)})
    return out


def merge_pieces(ww):
    """whisper splits '20,000' into '20' ',000' and 'ex-soldiers' into 'ex' '-soldiers': glue them back"""
    out = []
    for w in ww:
        if out and re.match(r"^[,.\-'%][0-9A-Za-z%]", w['w']):
            out[-1] = {'w': out[-1]['w'] + w['w'], 's': out[-1]['s'], 'e': w['e']}
        else:
            out.append(dict(w))
    return out


def align_whisper(toks, ww):
    ww = merge_pieces(ww)
    a = [norm(t['w']) for t in toks]
    b = [norm(w['w']) for w in ww]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    st = [None] * len(a)
    en = [None] * len(a)
    for i, j, n in sm.get_matching_blocks():
        for k in range(n):
            st[i + k], en[i + k] = ww[j + k]['s'], ww[j + k]['e']
    ok = [s is not None for s in st]
    matched = sum(ok)
    # interpolate the unmatched words between their matched neighbours (by syllables)
    k = 0
    while k < len(a):
        if st[k] is not None:
            k += 1
            continue
        j = k
        while j < len(a) and st[j] is None:
            j += 1
        t0 = en[k - 1] if k > 0 else 0.0
        t1 = st[j] if j < len(a) else (en[k - 1] or 0.0) + 0.35 * (j - k)
        wts = [syllables(toks[q]['w']) for q in range(k, j)]
        tot = sum(wts) or 1.0
        acc = t0
        for q, wt in zip(range(k, j), wts):
            st[q] = acc
            acc += (t1 - t0) * wt / tot
            en[q] = acc
        k = j
    return st, en, ok


# ------------------------------------------------------------------ island alignment
def weights(toks, idx):
    out = []
    for i in idx:
        w = toks[i]['w']
        x = syllables(w) + 0.25
        if STRONG.search(w):
            x += 1.0          # sentence-final lengthening
        elif WEAK.search(w):
            x += 0.5
        out.append(x)
    return out


def align_islands(toks, scenes, runs, prior=None):
    """Assign each scene's words to the speech between its pauses.

    A DP picks which pauses are word boundaries (preferring punctuation, matching each stretch's
    length to its words' syllable weight and, when available, whisper's estimate) and which are
    short gaps inside a phrase. Words never land inside silence and every boundary sits on a real pause.
    """
    st = [0.0] * len(toks)
    en = [0.0] * len(toks)
    for sc in scenes:
        idx = [i for i, t in enumerate(toks) if t['scene'] == sc['n']]
        if not idx:
            continue
        S, E = sc['start'], sc['end']
        P = [(a, b) for a, b in runs if a > S + 0.03 and b < E - 0.03]
        wt = weights(toks, idx)
        N, M = len(idx), len(P)
        cw = [0.0]
        for x in wt:
            cw.append(cw[-1] + x)
        speech_total = (E - S) - sum(b - a for a, b in P)
        rate = speech_total / cw[-1]
        # node p: 0 = scene start, 1..M = pause p-1, M+1 = scene end
        node_end = [S] + [b for a, b in P] + [E]      # where speech resumes after the node
        node_start = [S] + [a for a, b in P] + [E]    # where speech stops at the node

        def skip_cost(p):
            a, b = P[p - 1]
            L = b - a
            return 0.15 if L < 0.18 else (0.6 if L < 0.3 else 2.5)

        def bound_cost(p, last_word_local):
            a, b = P[p - 1]
            L = b - a
            w = toks[idx[last_word_local]]['w']
            if STRONG.search(w):
                return 0.0
            if WEAK.search(w):
                return 0.15
            return 0.5 if L < 0.3 else 1.0

        def seg_cost(p, q, i, j):
            """words i..j-1 spoken between node p and node q (pauses p+1..q-1 skipped)"""
            region = node_start[q] - node_end[p] - sum(P[k - 1][1] - P[k - 1][0] for k in range(p + 1, q))
            pred = max(0.12, rate * (cw[j] - cw[i]))
            c = 2.0 * math.log(max(0.05, region) / pred) ** 2
            if prior is not None:
                pc = 0.0
                if prior[2][idx[i]]:
                    pc += abs(prior[0][idx[i]] - node_end[p])
                if prior[2][idx[j - 1]]:
                    pc += abs(prior[1][idx[j - 1]] - node_start[q])
                c += min(3.0, pc)
            return c

        INF = float('inf')
        D = [[INF] * (N + 1) for _ in range(M + 2)]
        bt = {}
        D[0][0] = 0.0
        MAXSKIP, MAXW = 8, 45
        for p in range(M + 1):
            for i in range(N):
                if D[p][i] == INF:
                    continue
                for q in range(p + 1, min(M + 1, p + 1 + MAXSKIP) + 1):
                    skipped = sum(skip_cost(k) for k in range(p + 1, q))
                    if q == M + 1:
                        js = [N]
                    else:
                        js = range(i + 1, min(N - 1, i + MAXW) + 1)
                    for j in js:
                        c = D[p][i] + skipped + seg_cost(p, q, i, j)
                        if q <= M:
                            c += bound_cost(q, j - 1)
                        if c < D[q][j]:
                            D[q][j] = c
                            bt[(q, j)] = (p, i)
        if D[M + 1][N] == INF:
            C.die(f'could not align scene {sc["n"]}')
        segs = []
        q, j = M + 1, N
        while (q, j) != (0, 0):
            p, i = bt[(q, j)]
            segs.append((p, q, i, j))
            q, j = p, i
        segs.reverse()
        for p, q, i, j in segs:
            t0, t1 = node_end[p], node_start[q]
            gaps = [P[k - 1] for k in range(p + 1, q)]
            ks = list(range(i, j))
            if prior is not None and all(prior[2][idx[k]] for k in ks):
                ps, pe = prior[0][idx[i]], prior[1][idx[j - 1]]
                if pe - ps > 0.05:
                    for k in ks:
                        a = (prior[0][idx[k]] - ps) / (pe - ps)
                        b = (prior[1][idx[k]] - ps) / (pe - ps)
                        st[idx[k]] = t0 + min(1, max(0, a)) * (t1 - t0)
                        en[idx[k]] = t0 + min(1, max(0, b)) * (t1 - t0)
                    continue
            speech = (t1 - t0) - sum(b - a for a, b in gaps)
            tot = sum(wt[k] for k in ks) or 1.0

            def real(u):
                t = t0
                for a, b in gaps:
                    if t + u <= a:
                        break
                    u -= max(0.0, a - t)
                    t = b
                return t + u
            acc = 0.0
            for k in ks:
                st[idx[k]] = real(acc)
                acc += speech * wt[k] / tot
                en[idx[k]] = real(acc)
    return st, en


def correct_starts(st, en, runs):
    """a start that falls inside a pause moves to where speech resumes"""
    out = []
    for s, e in zip(st, en):
        best = s
        for a, b in runs:
            if a <= s < b - 0.02:
                best = max(best, b)
        out.append(min(best, max(s, e - 0.02)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scenes', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--method', default='auto', choices=['auto', 'whisper', 'pauses'])
    ap.add_argument('--names', default='', help='proper nouns to help whisper spell them')
    a = ap.parse_args()

    meta = C.load_json(a.scenes)
    scenes = meta['scenes']
    vo = meta['voiceover']
    x = C.decode(vo, SR)
    runs = C.silence_runs(x, SR, -40.0, 0.12)
    toks = tokens_from_scenes(scenes)

    method = a.method
    st = en = None
    miss = []
    if method in ('auto', 'whisper'):
        try:
            cache = os.path.join(os.path.dirname(os.path.abspath(a.out)), 'whisper_raw.json')
            stamp = [os.path.getsize(vo), int(os.path.getmtime(vo))]
            ww = None
            if os.path.exists(cache):
                c = C.load_json(cache)
                if c.get('stamp') == stamp:
                    ww = c['words']
            if ww is None:
                ww = whisper_words(vo, a.names)
                C.save_json(cache, {'stamp': stamp, 'words': ww})
            st, en, ok = align_whisper(toks, ww)
            matched = sum(ok)
            print(f'whisper: matched {matched}/{len(toks)} script words')
            miss = [i for i, o in enumerate(ok) if not o]
            if matched < 0.8 * len(toks):
                print('whisper match rate low; using pause-based timing instead')
                st = None
            method = 'whisper'
        except Exception as e:
            if a.method == 'whisper':
                C.die(f'whisper failed: {e}')
            print(f'whisper unavailable ({type(e).__name__}); using pause-based timing')
    if st is None:
        st, en = align_islands(toks, scenes, runs)
        method = 'pauses'
    else:
        st, en = align_islands(toks, scenes, runs, prior=(st, en, ok))
    st = correct_starts(st, en, runs)
    if method == 'whisper' and miss:
        print('not heard by whisper (check these spots if several sit together):')
        print('  ' + ', '.join(f"w{i} {toks[i]['w']!r} @{st[i]:.1f}s" for i in miss[:40]))

    words = [{'i': i, 'w': t['w'], 's': round(s, 3), 'e': round(e, 3), 'scene': t['scene'], 'sent': t['sent']}
             for i, (t, s, e) in enumerate(zip(toks, st, en))]
    for w0, w1 in zip(words, words[1:]):
        gap = w1['s'] - w0['e']
        if w0['sent'] == w1['sent'] and gap > 1.5:
            print(f"NOTE: {gap:.1f}s pause inside a sentence at {w0['e']:.1f}s (between w{w0['i']} {w0['w']!r} and "
                  f"w{w1['i']} {w1['w']!r}). Plan for it: a beat (sound effect, caption, reaction shot) or regenerate the scene.")
    C.save_json(a.out, words)
    d = os.path.dirname(os.path.abspath(a.out))
    C.save_json(os.path.join(d, 'silences.json'), [list(r) for r in runs])
    lines, cur = [], None
    for w in words:
        if w['sent'] != cur:
            lines.append(f"\n[scene {w['scene']}] ")
            cur = w['sent']
        lines.append(f"w{w['i']}@{w['s']:.2f} {w['w']}  ")
    with open(os.path.join(d, 'words.txt'), 'w', encoding='utf-8') as f:
        f.write(f'# method: {method}. Use wN in the edit plan for "start of word N".\n' + ''.join(lines).strip() + '\n')
    print(f'{len(words)} words, method={method}, {len(runs)} pauses -> {a.out} (+ words.txt, silences.json)')


if __name__ == '__main__':
    main()
