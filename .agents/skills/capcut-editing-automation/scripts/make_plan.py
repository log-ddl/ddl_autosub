"""Start an edit plan from the timed shot list. Claude then adds music, sfx and text cues to it.

usage: python3 make_plan.py --shots work/timing/shots_timed.json --manifest work/shots/manifest.json \
          --vo "<media folder>/<Video Name> voiceover.wav" --words work/timing/words.json --out work/edit_plan.json \
          [--map LOCAL_PREFIX DEVICE_PREFIX]...

--map tells the builder where each folder you read here lives on the viewer's computer (real paths), e.g.
   --map "<media folder as seen here>/" "/Users/sam/Movies/CapCut Automation/Emu War/"
   --map "<sounds folder as seen here>/" "/Users/sam/Documents/Sound Library/"
(more can be added to "path_map" later; Windows paths are fine: "C:/Users/sam/Videos/CapCut Automation/Emu War/").
--vo must be the voiceover copy INSIDE the media folder (the one the viewer imports), not the work copy.
"""
import argparse
import os
import common as C


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shots', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--vo', required=True)
    ap.add_argument('--words', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--map', nargs=2, action='append', default=[], metavar=('LOCAL', 'DEVICE'))
    a = ap.parse_args()
    timed = C.load_json(a.shots)
    man = {m['n']: m for m in C.load_json(a.manifest)}
    shots = []
    for i, r in enumerate(timed['shots']):
        m = man.get(r['n'])
        if not m:
            C.die(f"no image for shot {r['n']} in the manifest")
        shots.append({'n': r['n'], 'file': m['jpg'], 'analysis': m['png'],
                      'zoom': 'in' if i % 2 == 0 else 'out'})
    plan = {
        'fps': timed.get('fps', 30),
        'end': timed['end'],
        'words': os.path.abspath(a.words),
        'shots_file': os.path.abspath(a.shots),
        'path_map': [[os.path.abspath(l) + ('/' if l.endswith(('/', '\\')) else ''), d] for l, d in a.map],
        'vo': {'file': os.path.abspath(a.vo)},
        'zoom': {'per_sec': 0.011, 'min': 0.015, 'max': 0.045},
        'shots': shots,
        'music': [],
        'sfx': [],
        'text': [],
    }
    C.save_json(a.out, plan)
    print(f'{len(shots)} shots -> {a.out}. Next: add music, sfx and text cues (see references/capcut-edit.md).')


if __name__ == '__main__':
    main()
