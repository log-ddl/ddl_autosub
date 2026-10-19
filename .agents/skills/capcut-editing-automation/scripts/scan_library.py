"""Index the viewer's own music + sound-effects folder and find candidates by name.

Build the index (pick one source):
  python3 scan_library.py index --root "/path/as/seen/here/Sound Library" --device-root "/Users/name/Documents/Sound Library" --out work/library.json
  python3 scan_library.py index --listing work/listing.txt --device-root "/Users/name/Documents/Sound Library" --out work/library.json
      (listing.txt = one absolute path per line, e.g. from `find <folder> -type f` run on the viewer's computer)
Search it:
  python3 scan_library.py find --lib work/library.json --q "whoosh, swoosh" [--kind sfx] [--n 15]
  python3 scan_library.py cues --lib work/library.json          # best 3 files for every moment type in assets/sfx_cues.json
  python3 scan_library.py music --lib work/library.json [--q "quirky, comedy, marimba"]
"""
import argparse
import os
import re
import common as C

AUDIO = ('.wav', '.mp3', '.m4a', '.aac', '.aif', '.aiff', '.flac', '.ogg')
MUSIC_HINT = re.compile(r'\b(music|musics|songs?|tracks?|soundtracks?|bgm|score|beds?|instrumentals?|loops?|mix|playlist|background)\b', re.I)
SFX_HINT = re.compile(r'\b(sfx|fx|sound ?effects?|foley|whoosh\w*|swoosh\w*|transitions?|hits?|impacts?|ui|risers?|stingers?|'
                      r'ambien\w*|atmos\w*|cartoon|comedy fx|notifications?|clicks?|pops?)\b', re.I)


def classify(rel, size):
    parts = re.split(r'[/\\]', rel)
    folders = ' '.join(parts[:-1])
    name = parts[-1]
    if SFX_HINT.search(folders):
        return 'sfx', False
    if MUSIC_HINT.search(folders):
        return 'music', False
    if SFX_HINT.search(name):
        return 'sfx', True
    if MUSIC_HINT.search(name):
        return 'music', True
    ext = os.path.splitext(name)[1].lower()
    big = size > (12_000_000 if ext in ('.wav', '.aif', '.aiff', '.flac') else 2_500_000)
    return ('music' if big else 'sfx'), True


def tags(rel):
    t = re.sub(r'[_\-.\[\]()]+', ' ', os.path.splitext(rel)[0]).lower()
    return re.sub(r'\s+', ' ', t).strip()


def cmd_index(a):
    files = []
    if a.root:
        root = os.path.abspath(a.root)
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if not d.startswith('.')]
            for f in fn:
                if f.lower().endswith(AUDIO) and not f.startswith('._'):
                    p = os.path.join(dp, f)
                    try:
                        size = os.path.getsize(p)
                    except OSError:
                        size = 0
                    files.append((os.path.relpath(p, root).replace('\\', '/'), size))
    elif a.listing:
        dr = a.device_root.rstrip('/\\')
        for line in open(a.listing, encoding='utf-8', errors='ignore'):
            p = line.strip()
            if not p.lower().endswith(AUDIO) or '/._' in p:
                continue
            size = 0
            m = re.match(r'^(\d+)\t(.*)$', p)
            if m:
                size, p = int(m.group(1)), m.group(2)
            rel = p[len(dr):].lstrip('/\\') if p.startswith(dr) else p
            files.append((rel.replace('\\', '/'), size))
    else:
        C.die('give --root or --listing')
    out = []
    for rel, size in files:
        kind, guessed = classify(rel, size)
        out.append({'rel': rel, 'kind': kind, 'guessed': guessed, 'bytes': size, 'tags': tags(rel)})
    lib = {'root': os.path.abspath(a.root) if a.root else None, 'device_root': a.device_root, 'files': out}
    C.save_json(a.out, lib)
    n_m = sum(f['kind'] == 'music' for f in out)
    print(f'{len(out)} audio files ({n_m} music, {len(out) - n_m} sfx) -> {a.out}')
    tops = {}
    for f in out:
        top = f['rel'].split('/')[0] if '/' in f['rel'] else '(top level)'
        tops.setdefault(top, [0, 0])[0 if f['kind'] == 'music' else 1] += 1
    for k, (m, s) in sorted(tops.items(), key=lambda x: -sum(x[1]))[:25]:
        print(f'  {k}: {m} music, {s} sfx')


def score(f, kws):
    best = 0.0
    for rank, kw in enumerate(kws):
        kw = kw.strip().lower()
        if not kw:
            continue
        if re.search(r'\b' + re.escape(kw) + r'\b', f['tags']):
            s = 10 - rank * 0.5
            name = tags(os.path.basename(f['rel']))
            if re.search(r'\b' + re.escape(kw) + r'\b', name):
                s += 3
            best = max(best, s)
    return best


def search(lib, kws, kind=None, n=15):
    res = []
    for f in lib['files']:
        if kind and f['kind'] != kind:
            continue
        s = score(f, kws)
        if s > 0:
            res.append((s, f))
    res.sort(key=lambda x: (-x[0], len(x[1]['rel'])))
    return [f for _, f in res[:n]]


def show(lib, f):
    dev = (lib['device_root'].rstrip('/\\') + '/' + f['rel']) if lib.get('device_root') else f['rel']
    return f"[{f['kind']}{'?' if f['guessed'] else ''}] {f['rel']}   ->  {dev}"


def cmd_find(a):
    lib = C.load_json(a.lib)
    for f in search(lib, a.q.split(','), a.kind, a.n):
        print(show(lib, f))


def cmd_cues(a):
    lib = C.load_json(a.lib)
    cues = C.load_json(os.path.join(C.ASSETS, 'sfx_cues.json'))
    for cue, kws in cues.items():
        if cue.startswith('_'):
            continue
        hits = search(lib, kws, 'sfx', 3)
        print(f'{cue}:')
        for f in hits:
            print('    ' + f['rel'])
        if not hits:
            print('    (nothing obvious)')


def cmd_music(a):
    lib = C.load_json(a.lib)
    if a.q:
        hits = search(lib, a.q.split(','), 'music', a.n)
    else:
        hits = [f for f in lib['files'] if f['kind'] == 'music'][:a.n]
    for f in hits:
        print(show(lib, f))


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    i = sp.add_parser('index')
    i.add_argument('--root')
    i.add_argument('--listing')
    i.add_argument('--device-root', default='')
    i.add_argument('--out', required=True)
    f = sp.add_parser('find')
    f.add_argument('--lib', required=True)
    f.add_argument('--q', required=True)
    f.add_argument('--kind', choices=['music', 'sfx'])
    f.add_argument('--n', type=int, default=15)
    c = sp.add_parser('cues')
    c.add_argument('--lib', required=True)
    m = sp.add_parser('music')
    m.add_argument('--lib', required=True)
    m.add_argument('--q')
    m.add_argument('--n', type=int, default=40)
    a = ap.parse_args()
    {'index': cmd_index, 'find': cmd_find, 'cues': cmd_cues, 'music': cmd_music}[a.cmd](a)


if __name__ == '__main__':
    main()
