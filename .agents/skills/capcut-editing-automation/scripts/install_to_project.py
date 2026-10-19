"""Install a built timeline into a CapCut project folder this machine can write to directly.

usage: python3 install_to_project.py --build work/build --project "/path/to/com.lveditor.draft/<project folder>" \
           [--expect-md5 MD5_OF_THE_PROJECT_FILE_WHEN_STAGED] [--dry-run]

Use it when the project folder is reachable from where this runs (Cowork / a shell on the viewer's computer).
CapCut must be fully quit first, otherwise it overwrites the new timeline when it closes.

1. checks the project file is plain JSON and (with --expect-md5) unchanged since it was copied for the build
2. backs up every file it will touch into <project>/_backup_before_cca_<timestamp>/
3. writes the timeline to every copy CapCut keeps (root file, .bak, template-2.tmp and the same three
   inside Timelines/<timeline id>/; template.tmp is a different, older structure and is left alone)
4. updates tm_duration in draft_meta_info.json so the project card shows the right length
5. re-reads every written file and compares checksums
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import time
import common as C


def md5(p):
    return hashlib.md5(open(p, 'rb').read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build', required=True)
    ap.add_argument('--project', required=True)
    ap.add_argument('--expect-md5')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    rep = C.load_json(os.path.join(a.build, 'build_report.json'))
    name = rep['content_name']
    built = os.path.join(a.build, name)
    P = a.project
    main_file = os.path.join(P, name)
    if not os.path.exists(main_file):
        other = 'draft_content.json' if name == 'draft_info.json' else 'draft_info.json'
        if os.path.exists(os.path.join(P, other)):
            C.die(f'this project uses {other} but the build was made from a {name} project; rebuild from this project')
        C.die(f'{main_file} not found: is this the right project folder?')
    if not open(main_file, 'rb').read(64).lstrip().startswith(b'{'):
        C.die('the project file is not plain JSON (encrypted CapCut build); see references/troubleshooting.md')
    if a.expect_md5 and md5(main_file) != a.expect_md5:
        C.die('the project changed since it was copied for the build (was CapCut opened?). '
              'Quit CapCut, copy the project again and rebuild.')

    tid = rep.get('timeline_id')
    pj = os.path.join(P, 'Timelines', 'project.json')
    if os.path.exists(pj):
        tid = C.load_json(pj).get('main_timeline_id') or tid
    rels = [name, name + '.bak', 'template-2.tmp']
    if tid and os.path.isdir(os.path.join(P, 'Timelines', tid)):
        rels += [os.path.join('Timelines', tid, r) for r in (name, name + '.bak', 'template-2.tmp')]
    targets = [r for r in rels if r == name or os.path.exists(os.path.join(P, r))]
    meta_p = os.path.join(P, 'draft_meta_info.json')

    if a.dry_run:
        print('would write:', *targets, sep='\n  ')
        return

    if not os.access(P, os.W_OK):
        C.die(f'cannot write to {P}: give this session write access to the CapCut projects folder')
    bk = os.path.join(P, '_backup_before_cca_' + time.strftime('%Y%m%d-%H%M%S'))
    for r in targets + (['draft_meta_info.json'] if os.path.exists(meta_p) else []) + \
            ([os.path.join('Timelines', 'project.json')] if os.path.exists(pj) else []):
        src = os.path.join(P, r)
        if os.path.exists(src):
            dst = os.path.join(bk, r)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    def writable(p):
        """some projects have read-only copies: make them writable, return the mode to restore"""
        if not os.path.exists(p):
            return None
        mode = os.stat(p).st_mode
        if not os.access(p, os.W_OK):
            try:
                os.chmod(p, mode | stat.S_IWUSR)
            except OSError as e:
                C.die(f'{p} is read-only and its permissions cannot be changed ({e}). Nothing was overwritten; '
                      f'the backup is in {bk}')
        return mode

    for r in targets:
        p = os.path.join(P, r)
        mode = writable(p)
        shutil.copyfile(built, p)
        if mode is not None:
            os.chmod(p, mode | stat.S_IWUSR)
    if os.path.exists(meta_p):
        meta = C.load_json(meta_p)
        D = C.load_json(built)
        meta['tm_duration'] = D['duration']
        meta['tm_draft_modified'] = int(time.time() * 1e6)
        writable(meta_p)
        with open(meta_p, 'w', encoding='utf-8') as f:
            f.write(json.dumps(meta, ensure_ascii=False, separators=(',', ':')))
    want = md5(built)
    bad = [r for r in targets if md5(os.path.join(P, r)) != want]
    if bad:
        C.die('verification failed for: ' + ', '.join(bad))
    print(f'installed into {P}\n  wrote: ' + ', '.join(targets) + f'\n  backup: {bk}\n  all copies verified (md5 {want})')


if __name__ == '__main__':
    main()
