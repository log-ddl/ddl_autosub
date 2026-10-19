"""Build a complete CapCut timeline (draft file) from an edit plan.

usage: python3 build_capcut.py --plan work/edit_plan.json --project work/capcut_project --out work/build
           [--capcut-font /path/to/CapCut/en.ttf] [--font-path-in-draft "C:/Users/.../SystemFont/en.ttf"]

--project  a folder holding copies of the viewer's (empty) CapCut project files:
           draft_info.json (Mac) or draft_content.json (Windows) + draft_meta_info.json [+ Timelines/project.json]
--out      receives the finished draft file (same name as the project's), draft_meta_info.json,
           build_report.json (used by preview.py), report.md and install_targets.txt

What it builds (every object cloned from drafts CapCut itself saved, fresh ids):
  video track   one photo segment per shot, cut exactly on the shot times, each with a subtle keyframed
                zoom (alternating in / out, amount scales with shot length)
  audio tracks  voiceover at unity; music auto-levelled under the voice with volume keyframes (+ optional
                comic dropouts and a lift for the ending); sound effects levelled against the voice, packed
                onto as few tracks as possible
  text tracks   captions sized to fit inside the 5% safe area, placed on the least busy part of the image,
                with a small pop-in scale animation
"""
import argparse
import copy
import hashlib
import json
import os
import re
import time
import uuid
import numpy as np
import common as C
import textfit
import analyze_audio as AA

LEVELS = {'hit': -0.5, 'accent': -3.5, 'soft': -6.5, 'bed': -10.0, 'low': -13.0}
PEAK_CEIL = -4.0           # dBFS ceiling per sound effect
MAC_FONT = '/Applications/CapCut.app/Contents/Resources/Font/SystemFont/en.ttf'


def U():
    return str(uuid.uuid4()).upper()


class Builder:
    def __init__(self, a):
        self.a = a
        self.plan = C.load_json(a.plan)
        self.fps = int(self.plan.get('fps', 30))
        self.warn = []
        self.cache = AA.Cache(os.path.join(os.path.dirname(os.path.abspath(a.plan)), 'audio_cache.json'))
        self.load_project()
        self.T = C.load_json(os.path.join(C.ASSETS, 'capcut_templates.json'))
        self.words = C.load_json(self.plan['words']) if self.plan.get('words') else None
        self.timed = C.load_json(self.plan['shots_file']) if self.plan.get('shots_file') else None
        self.font_file = textfit.set_font(a.capcut_font)
        os_name = (self.skel.get('platform') or {}).get('os', 'mac')
        self.os = 'windows' if 'win' in os_name else 'mac'
        harvested = next((t.get('font_path') for t in (self.skel.get('materials') or {}).get('texts', [])
                          if t.get('font_path')), None)
        if a.font_path_in_draft is not None:
            self.draft_font = a.font_path_in_draft
        elif harvested:
            self.draft_font = harvested          # the viewer's own CapCut wrote this path: always right
        else:
            self.draft_font = MAC_FONT if self.os == 'mac' else ''   # '' = CapCut's default font
        self.paths = {}            # device path -> local path (for preview)

    # ------------------------------------------------------------- project
    def load_project(self):
        d = self.a.project
        names = [n for n in ('draft_info.json', 'draft_content.json') if os.path.exists(os.path.join(d, n))]
        if not names:
            C.die(f'no draft_info.json or draft_content.json in {d}')
        self.content_name = names[0]
        raw = open(os.path.join(d, self.content_name), 'rb').read()
        if not raw.lstrip().startswith(b'{'):
            C.die(f'{self.content_name} is not plain JSON (this CapCut build encrypts its projects). '
                  'See references/troubleshooting.md: "Encrypted project".')
        self.skel = json.loads(raw.decode('utf-8'))
        mp = os.path.join(d, 'draft_meta_info.json')
        self.meta = C.load_json(mp) if os.path.exists(mp) else None
        pj = os.path.join(d, 'Timelines', 'project.json')
        self.timeline_id = C.load_json(pj).get('main_timeline_id') if os.path.exists(pj) else self.skel.get('id')
        if self.skel.get('tracks'):
            n = sum(len(t.get('segments', [])) for t in self.skel['tracks'])
            if n:
                self.warn.append(f'the project timeline already had {n} clips; the build replaces the whole timeline')
        self.bin = {}
        if self.meta and not any(g.get('value') for g in self.meta.get('draft_materials', [])):
            self.warn.append("the project's media bin is empty, so the viewer may not have imported the media "
                             "(the timeline doesn't need it, but check they used the right project)")
        if self.meta:
            for grp in self.meta.get('draft_materials', []):
                for m in grp.get('value', []):
                    p = m.get('file_Path') or ''
                    if p:
                        self.bin.setdefault(re.split(r'[/\\]', p)[-1], []).append(p)

    # ------------------------------------------------------------- paths
    def device(self, item):
        """local file -> path on the viewer's computer"""
        local = item['file'] if isinstance(item, dict) else item
        if isinstance(item, dict) and item.get('device'):
            dev = item['device']
        else:
            dev = None
            la = os.path.abspath(local).replace('\\', '/')
            for l, d in self.plan.get('path_map', []):
                l = os.path.abspath(l).replace('\\', '/').rstrip('/') + '/'
                if la.startswith(l):
                    rest = la[len(l):]
                    sep = '\\' if ('\\' in d and '/' not in d) else '/'
                    dev = d.rstrip('/\\') + sep + rest.replace('/', sep)
                    break
            if dev is None:
                hits = self.bin.get(os.path.basename(local), [])
                if len(hits) == 1:
                    dev = hits[0]
                elif len(hits) > 1:
                    C.die(f'{os.path.basename(local)} appears {len(hits)} times in the CapCut media bin; give "device" explicitly')
        if dev is None:
            C.die(f'no device path for {local}: add a path_map entry or import the file into the CapCut project')
        self.paths[dev] = os.path.abspath(local)
        return dev

    # ------------------------------------------------------------- time
    def t(self, x):
        return C.resolve_time(x, self.words, self.cuts, self.END)

    def fr(self, t):
        return C.fr(t, self.fps)

    def us(self, f):
        return C.us(f, self.fps)

    def rng(self, t0, t1):
        a, b = self.us(self.fr(t0)), self.us(self.fr(t1))
        return a, b - a

    # ------------------------------------------------------------- materials
    def reset_materials(self):
        self.M = copy.deepcopy(self.skel['materials'])
        for k in self.M:
            if isinstance(self.M[k], list):
                self.M[k] = []
        for k in ('videos', 'audios', 'texts', 'speeds', 'placeholder_infos', 'canvases', 'material_animations',
                  'sound_channel_mappings', 'material_colors', 'loudnesses', 'vocal_separations', 'audio_fades'):
            self.M.setdefault(k, [])

    def add(self, kind, tmpl, **kw):
        o = copy.deepcopy(tmpl)
        o['id'] = U()
        o.update(kw)
        self.M.setdefault(kind, []).append(o)
        return o['id']

    def extras(self, group, skip=()):
        out = []
        for kind, tmpl in self.T[group].items():
            if kind in skip:
                continue
            out.append(self.add(kind, tmpl))
        return out

    @staticmethod
    def kf(prop, pts):
        return {'id': U(), 'material_id': '', 'property_type': prop,
                'keyframe_list': [{'id': U(), 'curveType': 'Line', 'time_offset': int(t), 'left_control': {'x': 0.0, 'y': 0.0},
                                   'right_control': {'x': 0.0, 'y': 0.0}, 'values': [float(v)], 'string_value': '',
                                   'graphID': ''} for t, v in pts]}

    @staticmethod
    def track(kind):
        return {'id': U(), 'type': kind, 'flag': 0, 'attribute': 0, 'name': '', 'is_default_name': True, 'segments': []}

    # ------------------------------------------------------------- video
    def build_video(self):
        P = self.plan
        z = P.get('zoom', {})
        per, zmin, zmax = z.get('per_sec', 0.011), z.get('min', 0.015), z.get('max', 0.045)
        timed = {r['n']: r for r in (self.timed['shots'] if self.timed else [])}
        shots = P['shots']
        starts = []
        for k, sh in enumerate(shots):
            r = timed.get(sh['n'], {})
            s = self.t(sh['start']) if 'start' in sh else r.get('start')
            if s is None:
                C.die(f"shot {sh['n']} has no start time")
            starts.append(0.0 if k == 0 else s)
        self.cuts = {sh['n']: s for sh, s in zip(shots, starts)}
        end = P.get('end', 'auto')
        if end in (None, 'auto'):
            end = self.timed['end'] if self.timed else None
        self.END = C.fsnap(float(end), self.fps)
        vtrack = self.track('video')
        self.shot_spans = []
        for k, sh in enumerate(shots):
            t0 = starts[k]
            t1 = starts[k + 1] if k + 1 < len(shots) else self.END
            start, dur = self.rng(t0, t1)
            if dur <= 0:
                C.die(f"shot {sh['n']} has no length ({t0:.3f}-{t1:.3f})")
            d = dur / 1e6
            amt = round(min(zmax, max(zmin, per * d)), 4)
            mode = sh.get('zoom', 'in' if k % 2 == 0 else 'out')
            if isinstance(mode, (int, float)):
                amt, mode = abs(float(mode)), ('in' if mode >= 0 else 'out')
            s0, s1 = {'in': (1.0, 1.0 + amt), 'out': (1.0 + amt, 1.0), 'none': (1.0, 1.0)}[mode]
            dev = self.device(sh)
            vm_id = self.add('videos', self.T['photo_material'], path=dev, width=1920, height=1080,
                             material_name=os.path.basename(dev.replace('\\', '/')), local_material_id='',
                             media_path='', unique_id='')
            refs = self.extras('video_extras')
            last = dur - self.us(1)
            seg = copy.deepcopy(self.T['video_segment'])
            seg.update({'id': U(), 'source_timerange': {'start': 0, 'duration': dur},
                        'target_timerange': {'start': start, 'duration': dur}, 'material_id': vm_id,
                        'extra_material_refs': refs, 'render_index': 0, 'track_render_index': 0,
                        'keyframe_refs': [], 'volume': 1.0, 'last_nonzero_volume': 1.0})
            seg['clip'] = {'scale': {'x': s0, 'y': s0}, 'rotation': 0.0, 'transform': {'x': 0.0, 'y': 0.0},
                           'flip': {'vertical': False, 'horizontal': False}, 'alpha': 1.0}
            seg['uniform_scale'] = {'on': True, 'value': 1.0}
            seg['common_keyframes'] = [self.kf('KFTypePositionX', [(0, 0.0), (last, 0.0)]),
                                       self.kf('KFTypePositionY', [(0, 0.0), (last, 0.0)]),
                                       self.kf('KFTypeScaleX', [(0, s0), (last, s1)]),
                                       self.kf('KFTypeRotation', [(0, 0.0), (last, 0.0)])]
            vtrack['segments'].append(seg)
            self.shot_spans.append((t0, t1, sh.get('analysis') or sh['file']))
            if d < 1.0:
                self.warn.append(f"shot {sh['n']} is on screen for only {d:.2f}s")
        return vtrack

    def image_at(self, t):
        for t0, t1, img in self.shot_spans:
            if t0 - 1e-6 <= t < t1:
                return img
        return self.shot_spans[-1][2]

    # ------------------------------------------------------------- audio
    def audio_seg(self, path_local, path_dev, file_dur, t0, src, dur, vol, fin=0.0, fout=0.0, tri=0, vol_kf=None):
        name = os.path.basename(path_dev.replace('\\', '/'))
        a_id = self.add('audios', self.T['audio_material'], name=name, path=path_dev,
                        duration=int(round(file_dur * 1e6)), type='extract_music', category_name='local',
                        wave_points=[], unique_id='', local_material_id='')
        refs = [self.add('speeds', self.T['audio_extras']['speeds']),
                self.add('placeholder_infos', self.T['audio_extras']['placeholder_infos'])]
        if fin > 0 or fout > 0:
            refs.append(self.add('audio_fades', self.T['audio_extras']['audio_fades'],
                                 fade_in_duration=int(fin * 1e6), fade_out_duration=int(fout * 1e6)))
        for k in ('sound_channel_mappings', 'loudnesses', 'vocal_separations'):
            refs.append(self.add(k, self.T['audio_extras'][k]))
        start, d = self.rng(t0, t0 + dur)
        src_us = self.us(self.fr(src))            # CapCut snaps source starts to whole frames
        max_d = int(file_dur * 1e6) - src_us
        d = min(d, self.us(int(max_d * self.fps // 1000000)))
        if d <= 0:
            C.die(f'{name}: nothing left to play from {src:.2f}s (file is {file_dur:.2f}s)')
        seg = copy.deepcopy(self.T['audio_segment'])
        seg.update({'id': U(), 'source_timerange': {'start': src_us, 'duration': d},
                    'target_timerange': {'start': start, 'duration': d}, 'material_id': a_id,
                    'extra_material_refs': refs, 'volume': float(vol), 'last_nonzero_volume': 1.0,
                    'render_index': 0, 'track_render_index': tri, 'keyframe_refs': [], 'common_keyframes': []})
        if vol_kf:
            pts = {}
            for t, v in vol_kf:
                off = int(round((t - start / 1e6) * 1e6))
                off = max(0, min(d - self.us(1), off))
                pts[off] = v
            seg['common_keyframes'] = [self.kf('KFTypeVolume', sorted(pts.items()))]
        return seg

    def vo_level(self):
        x = AA.mono(self.vo_local)
        st = C.st200(x, AA.SR)
        sp = st[st > st.max() - 30]
        return float(np.median(sp))

    def build_vo(self):
        v = self.plan['vo']
        self.vo_local = os.path.abspath(v['file'])
        dev = self.device(v)
        dur = AA.analyze_sfx(self.vo_local, self.cache)['dur']
        self.vo_dur = dur
        tr = self.track('audio')
        tr['segments'].append(self.audio_seg(self.vo_local, dev, dur, self.t(v.get('start', 0.0)), 0.0,
                                             min(dur - 1 / self.fps, self.END), 1.0, tri=1))
        self.VO_MED = self.vo_level()
        return tr

    def build_music(self):
        tracks, report = [], []
        for mi, m in enumerate(self.plan.get('music', [])):
            local = os.path.abspath(m['file'])
            dev = self.device(m)
            an = AA.analyze_music(local, self.cache)
            fdur = an['dur']
            start = self.t(m.get('start', 0.0))
            end = self.t(m.get('end', 'end'))
            if m.get('align'):
                src = float(m['align']['music_t']) - (self.t(m['align']['at']) - start)
            else:
                src = float(m.get('src', 0.0))
            if src < 0:
                start += -src
                src = 0.0
            src = C.fsnap(src, self.fps)
            dur = min(end - start, fdur - src - 0.01)
            if dur <= 0.5:
                C.die(f'music item {mi + 1}: nothing to play (check start/end/src)')
            if end - start - dur > 0.5:
                self.warn.append(f"music '{os.path.basename(local)}' runs out {end - start - dur:.1f}s before its end time; "
                                 f"add another music item to cover the rest")
            ct = np.array([c[0] for c in an['curve']])
            cS = np.array([c[1] for c in an['curve']])
            used = (ct >= src + 3) & (ct <= src + dur - 3) & (cS > -45)
            S_MED = float(np.median(cS[used])) if used.any() else float(np.median(cS))
            target = float(m.get('target_lufs', -30.0))
            comp = float(m.get('duck', 0.6))

            def music_S(tl):
                vals = []
                for dd in np.arange(-2.0, 2.01, 0.5):
                    tt = max(1.5, tl - start + src + dd)
                    i = int(np.argmin(abs(ct - tt)))
                    vals.append(max(-40.0, cS[i]))
                return float(np.mean(vals))

            def gain(tl):
                g_db = (target - S_MED) + comp * (S_MED - music_S(tl))
                return 10 ** (min(10.0, g_db) / 20)

            dead = [(self.t(a), self.t(b)) for a, b in m.get('dropouts', [])]
            lift = m.get('lift')
            lift_at = self.t(lift['at']) if lift else None
            pts = []
            for tl in np.arange(start, start + dur, 2.0):
                if any(a - 0.4 <= tl <= b + 0.4 for a, b in dead):
                    continue
                if lift_at is not None and tl >= lift_at - 0.4:
                    continue
                pts.append((float(tl), gain(tl)))
            for a, b in dead:
                pts += [(a - 0.03, gain(a)), (a + 0.07, 0.0), (b - 0.02, 0.0), (b + 0.3, gain(b + 0.3))]
            if lift_at is not None:
                lv = gain(lift_at) * 10 ** (float(lift.get('db', 4.0)) / 20)
                pts += [(lift_at - 0.4, gain(lift_at - 0.4)), (lift_at + 0.1, lv), (start + dur - 1 / self.fps, lv)]
            pts.sort()
            kfs = [(t, round(v, 4)) for t, v in pts]
            seg = self.audio_seg(local, dev, fdur, start, src, dur, kfs[0][1],
                                 fin=float(m.get('fin', 0.3)), fout=float(m.get('fout', 1.4)), vol_kf=kfs)
            placed = False
            for tr in tracks:
                if tr['_end'] < seg['target_timerange']['start']:
                    tr['segments'].append(seg)
                    tr['_end'] = seg['target_timerange']['start'] + seg['target_timerange']['duration']
                    placed = True
                    break
            if not placed:
                tr = self.track('audio')
                tr['_end'] = seg['target_timerange']['start'] + seg['target_timerange']['duration']
                tr['segments'].append(seg)
                tracks.append(tr)
            sound_end_tl = start + (an['sound_end'] - src)
            if sound_end_tl < min(start + dur, self.END) - 4.0:
                self.warn.append(f"music '{os.path.basename(local)}' has faded out by {sound_end_tl:.1f}s, "
                                 f"{min(start + dur, self.END) - sound_end_tl:.1f}s before its section ends. A final chord "
                                 f"ringing under a short outro is fine; for longer, align its ending later or add another item")
            report.append({'file': os.path.basename(local), 'start': start, 'src': src, 'dur': dur,
                           'median_lufs': S_MED, 'keyframes': len(kfs), 'dropouts': dead, 'lift_at': lift_at})
        for tr in tracks:
            del tr['_end']
        self.music_report = report
        return tracks

    def build_sfx(self):
        items = []
        for k, s in enumerate(self.plan.get('sfx', [])):
            local = os.path.abspath(s['file'])
            dev = self.device(s)
            an = AA.analyze_sfx(local, self.cache)
            t = self.t(s['t'])
            align = s.get('align', 'onset')
            lv = s.get('level', 'accent')
            short = lv in ('hit', 'accent', 'soft') or not isinstance(lv, str)
            src = s.get('src')
            if src is None:
                if align == 'onset':
                    src = max(0.0, an['onset_t'] - 0.02)
                elif align == 'peak':
                    src = max(0.0, an['peak_t'] - 1.0)     # never start a long file seconds before its hit
                else:
                    src = 0.0
            src = C.fsnap(float(src), self.fps)
            start = t - (an['peak_t'] - src) if align == 'peak' else t
            dur = s.get('dur')
            trimmed = False
            if dur is None:
                dur = min(an['end_t'] + 0.05, an['dur']) - src
                if short:   # one-shot effects: keep the hit and a short tail, not a long ring-out under the voice
                    cue_off = (an['peak_t'] - src) if align == 'peak' else 0.0
                    cap = cue_off + 1.6
                    if dur > cap:
                        dur, trimmed = cap, True
            dur = min(float(dur), an['dur'] - src - 0.01)
            if start < 0:
                src, dur, start = src - start, dur + start, 0.0
            if start + dur > self.END:
                dur = self.END - start - 1 / self.fps
            if dur < 0.05:
                self.warn.append(f"sfx {k + 1} ({os.path.basename(local)} at {t:.2f}s) too short after trimming, skipped")
                continue
            if t - start > 1.5 and short:      # long build-ups are fine for bed/low risers and drum rolls
                self.warn.append(f"sfx {k + 1} ({os.path.basename(local)}) starts {t - start:.1f}s before its cue at {t:.2f}s; "
                                 f"set src/dur to take just the part you want")
            if short and dur > 3.0:
                self.warn.append(f"sfx {k + 1} ({os.path.basename(local)} at {t:.2f}s) plays {dur:.1f}s at level {lv!r}; "
                                 f"shorten it with dur or use level 'bed'/'low' for long sounds")
            fout = s.get('fout')
            if fout is None:
                fout = min(0.4, dur / 3) if trimmed else min(0.15, dur / 3)
            target = self.VO_MED + (LEVELS[lv] if isinstance(lv, str) else float(lv))
            st_seg, pk_seg = AA.seg_levels(local, src, dur)
            vol = min(10 ** ((target - st_seg) / 20), 10 ** ((PEAK_CEIL - pk_seg) / 20))
            vol = float(min(2.0, max(0.03, vol)))
            items.append({'local': local, 'dev': dev, 'file_dur': an['dur'], 'start': start, 'src': src, 'dur': dur,
                          'vol': vol, 'fin': float(s.get('fin', 0.0)), 'fout': float(fout), 'note': s.get('note', ''),
                          'level': lv, 'cue': t})
        tracks = []
        for it in sorted(items, key=lambda x: x['start']):
            f0, f1 = self.fr(it['start']), self.fr(it['start'] + it['dur'])
            for tr in tracks:
                if tr['_end'] < f0:
                    break
            else:
                tr = self.track('audio')
                tr['_end'] = -1
                tr['_items'] = []
                tracks.append(tr)
            tr['_end'] = f1
            tr['_items'].append(it)
        self.sfx_report = items
        return tracks

    # ------------------------------------------------------------- text
    def text_content(self, L):
        styles, pos = [], 0
        text = '\n'.join(L['lines'])
        for i, (line, size) in enumerate(zip(L['lines'], L['sizes'])):
            seg_len = len(line) + (1 if i < len(L['lines']) - 1 else 0)
            col = L['color'] if i < L['n_main'] else L['sub_color']
            if styles and styles[-1]['size'] == size and styles[-1]['fill']['content']['solid']['color'] == list(col):
                styles[-1]['range'][1] = pos + seg_len
            else:
                styles.append({'fill': {'content': {'render_type': 'solid', 'solid': {'color': list(col)}}},
                               'font': {'id': '', 'path': self.draft_font}, 'range': [pos, pos + seg_len],
                               'size': size, 'strokes': [{'content': {'render_type': 'solid', 'solid': {'color': [0, 0, 0]}},
                                                          'width': textfit.STROKE}]})
            pos += seg_len
        return json.dumps({'styles': styles, 'text': text}, ensure_ascii=False, separators=(',', ':'))

    def build_text(self, first_track_index):
        lays = []
        for k, tx in enumerate(self.plan.get('text', [])):
            t0, t1 = self.t(tx['start']), self.t(tx['end'])
            t1 = min(t1, self.END)
            if t1 - t0 < 0.3:
                self.warn.append(f"text {tx['text']!r} is only {t1 - t0:.2f}s long, skipped")
                continue
            L = textfit.layout(tx, self.image_at(t0 + 0.01))
            L.update({'start': t0, 'end': t1, 'img': self.image_at(t0 + 0.01)})
            if not L['fits']:
                C.die(f"text {tx['text']!r} cannot fit inside the frame even after shrinking")
            if L['busy'] > 0.3 and L['choice'] not in ('fixed',) and not tx.get('ok_busy'):
                self.warn.append(f"text {tx['text']!r} at {t0:.2f}s: no clear spot found (busy {L['busy']}); look at its still "
                                 f"and set pos/size, or add \"ok_busy\": true if it looks fine")
            if min(L['sizes'][:L['n_main']]) < 6.0:
                self.warn.append(f"text {tx['text']!r} at {t0:.2f}s is small (size {min(L['sizes'][:L['n_main']]):.1f}); "
                                 f"shorten the text or place it with pos/size")
            if t1 - t0 < 0.8:
                self.warn.append(f"text {tx['text']!r} is on screen for only {t1 - t0:.2f}s")
            lays.append(L)
        tracks = []
        for L in sorted(lays, key=lambda x: x['start']):
            f0, f1 = self.fr(L['start']), self.fr(L['end'])
            for tr in tracks:
                if tr['_end'] <= f0:
                    break
            else:
                tr = self.track('text')
                tr['_end'] = -1
                tr['_L'] = []
                tracks.append(tr)
            tr['_end'] = f1
            tr['_L'].append(L)
        for ti, tr in enumerate(tracks):
            for L in tr['_L']:
                start, dur = self.rng(L['start'], L['end'])
                fsz = float(L['sizes'][0])
                tm_id = self.add('texts', self.T['text_material'], content=self.text_content(L), font_size=fsz,
                                 font_path=self.draft_font, text_color='#%02X%02X%02X' % tuple(int(round(c * 255)) for c in L['color']),
                                 border_color='#000000', border_width=textfit.STROKE, line_spacing=textfit.LINE_GAP,
                                 alignment=1, line_max_width=0.82, fixed_width=-1.0, fixed_height=-1.0,
                                 words={'start_time': [], 'end_time': [], 'text': []},
                                 current_words={'start_time': [], 'end_time': [], 'text': []})
                an_id = self.add('material_animations', self.T['text_extras']['material_animations'])
                last = dur - self.us(1)
                seg = copy.deepcopy(self.T['text_segment'])
                seg.update({'id': U(), 'target_timerange': {'start': start, 'duration': dur}, 'material_id': tm_id,
                            'extra_material_refs': [an_id], 'render_index': 14000 + ti,
                            'track_render_index': first_track_index + ti, 'keyframe_refs': []})
                seg['clip'] = {'scale': {'x': 1.0, 'y': 1.0}, 'rotation': float(L['rot']),
                               'transform': {'x': round(L['tx'], 6), 'y': round(L['ty'], 6)},
                               'flip': {'vertical': False, 'horizontal': False}, 'alpha': 1.0}
                seg['uniform_scale'] = {'on': True, 'value': 1.0}
                pop = [(0, 0.80), (100000, textfit.POP_MAX), (200000, 1.0), (last, 1.02)]
                pop = [(t, v) for t, v in pop if t <= last]
                seg['common_keyframes'] = [self.kf('KFTypePositionX', [(0, L['tx']), (last, L['tx'])]),
                                           self.kf('KFTypePositionY', [(0, L['ty']), (last, L['ty'])]),
                                           self.kf('KFTypeScaleX', pop),
                                           self.kf('KFTypeRotation', [(0, L['rot']), (last, L['rot'])])]
                tr['segments'].append(seg)
            del tr['_end'], tr['_L']
        self.layouts = lays
        return tracks

    # ------------------------------------------------------------- assemble
    def build(self):
        self.reset_materials()
        self.cuts = {}
        self.END = None
        vtrack = self.build_video()
        votrack = self.build_vo()
        mtracks = self.build_music()
        sfx_tracks = self.build_sfx()
        audio_tracks = [votrack] + mtracks
        for tr in sfx_tracks:
            tri = len(audio_tracks) + 1
            tr['segments'] = [self.audio_seg(it['local'], it['dev'], it['file_dur'], it['start'], it['src'], it['dur'],
                                             it['vol'], fin=it['fin'], fout=it['fout'], tri=tri) for it in tr['_items']]
            del tr['_end'], tr['_items']
            audio_tracks.append(tr)
        for i, tr in enumerate(audio_tracks):
            for s in tr['segments']:
                s['track_render_index'] = i + 1
        text_tracks = self.build_text(1 + len(audio_tracks))
        D = copy.deepcopy(self.skel)
        D['tracks'] = [vtrack] + audio_tracks + text_tracks
        D['materials'] = self.M
        D['duration'] = self.us(self.fr(self.END))
        D['keyframes'] = {k: [] for k in (D.get('keyframes') or {'videos': [], 'audios': [], 'texts': []})}
        cc = D.get('canvas_config') or {}
        cc.update({'width': 1920, 'height': 1080})
        if cc.get('ratio') in (None, '', 'original'):
            cc['ratio'] = 'original'
        D['canvas_config'] = cc
        D['fps'] = float(self.fps)
        self.validate(D)
        self.D = D
        return D

    def validate(self, D):
        ids = set()
        for k, v in D['materials'].items():
            if isinstance(v, list):
                for x in v:
                    if isinstance(x, dict) and 'id' in x:
                        assert x['id'] not in ids, ('duplicate id', x['id'])
                        ids.add(x['id'])
        fps = self.fps
        for tr in D['tracks']:
            prev_end = -1
            for s in tr['segments']:
                assert s['material_id'] in ids, 'segment points at a missing material'
                assert all(r in ids for r in s['extra_material_refs']), 'missing extra material'
                st, du = s['target_timerange']['start'], s['target_timerange']['duration']
                assert du > 0 and st >= prev_end, (tr['type'], 'overlap or empty clip', st, prev_end)
                assert abs(st * fps / 1e6 - round(st * fps / 1e6)) < 1e-3, ('start not on a frame', st)
                assert tr['type'] == 'audio' or abs(du * fps / 1e6 - round(du * fps / 1e6)) < 1e-3, ('length not whole frames', du)
                assert st + du <= D['duration'] + 1, ('clip runs past the end', tr['type'], st + du, D['duration'])
                prev_end = st + du
                for k in s.get('common_keyframes', []):
                    for p in k['keyframe_list']:
                        assert 0 <= p['time_offset'] < du, ('keyframe outside its clip', k['property_type'])
        vt = D['tracks'][0]['segments']
        assert vt[0]['target_timerange']['start'] == 0, 'video must start at 0'
        for a, b in zip(vt, vt[1:]):
            assert a['target_timerange']['start'] + a['target_timerange']['duration'] == b['target_timerange']['start'], 'gap between shots'
        assert vt[-1]['target_timerange']['start'] + vt[-1]['target_timerange']['duration'] == D['duration'], 'last shot must reach the end'

    # ------------------------------------------------------------- outputs
    def write(self):
        out = self.a.out
        os.makedirs(out, exist_ok=True)
        blob = json.dumps(self.D, ensure_ascii=False, separators=(',', ':'))
        with open(os.path.join(out, self.content_name), 'w', encoding='utf-8') as f:
            f.write(blob)
        if self.meta is not None:
            meta = copy.deepcopy(self.meta)
            meta['tm_duration'] = self.D['duration']
            meta['tm_draft_modified'] = int(time.time() * 1e6)
            with open(os.path.join(out, 'draft_meta_info.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(meta, ensure_ascii=False, separators=(',', ':')))
        tid = self.timeline_id
        targets = [self.content_name, self.content_name + '.bak', 'template-2.tmp']
        targets += [f'Timelines/{tid}/{n}' for n in targets] if tid else []
        with open(os.path.join(out, 'install_targets.txt'), 'w') as f:
            f.write('\n'.join(targets) + '\n')
        lay = []
        for L in self.layouts:
            l2 = {k: v for k, v in L.items()}
            l2['color'] = list(L['color'])
            l2['sub_color'] = list(L['sub_color']) if L['sub_color'] else None
            lay.append(l2)
        rep = {'content_name': self.content_name, 'fps': self.fps, 'end': self.END, 'os': self.os,
               'timeline_id': tid, 'device_to_local': self.paths, 'layouts': lay, 'music': self.music_report,
               'vo_median_st': self.VO_MED, 'measure_font': self.font_file, 'draft_font': self.draft_font,
               'md5': hashlib.md5(blob.encode('utf-8')).hexdigest(), 'warnings': self.warn}
        C.save_json(os.path.join(out, 'build_report.json'), rep)
        tracks = [(t['type'], len(t['segments'])) for t in self.D['tracks']]
        lines = [f'# Build report', '',
                 f'- Timeline: {C.mmss(self.END)} at {self.fps} fps, {len(self.D["tracks"][0]["segments"])} shots',
                 f'- Tracks ({len(tracks)}; clips per track): ' + ', '.join(f'{t} {n}' for t, n in tracks),
                 f'- Sound effects: {len(self.sfx_report)} on {sum(1 for t in self.D["tracks"] if t["type"] == "audio") - 1 - len(self.music_report)} tracks',
                 f'- Music: ' + (', '.join(f"{m['file']} from {m['start']:.1f}s ({m['keyframes']} volume keyframes)" for m in self.music_report) or 'none'),
                 f'- Captions: {len(self.layouts)} (all inside the 5% safe area)',
                 f'- Draft file: {self.content_name}, md5 {rep["md5"]}', '']
        if self.warn:
            lines += ['## Warnings', ''] + [f'- {w}' for w in self.warn] + ['']
        lines += ['## Captions', '', '| Time | Text | Style | Size | Where | Busy |', '| --- | --- | --- | --- | --- | --- |']
        for L in self.layouts:
            lines.append(f"| {C.mmss(L['start'])}-{C.mmss(L['end'])} | {L['text']!r} | {L['style']} | {L['size_final']} | "
                         f"{L['choice']} ({L['cx']:.0f},{L['cy']:.0f}) | {L['busy']} |")
        lines += ['', '## Sound effects', '', '| Cue | Clip starts | Length | File (from s) | Level | Vol | Note |',
                  '| --- | --- | --- | --- | --- | --- | --- |']
        for it in sorted(self.sfx_report, key=lambda x: x['cue']):
            lines.append(f"| {it['cue']:.2f} | {it['start']:.2f} | {it['dur']:.2f} | {os.path.basename(it['local'])} "
                         f"({it['src']:.2f}) | {it['level']} | {it['vol']:.2f} | {it['note']} |")
        with open(os.path.join(out, 'report.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')
        with open(os.path.join(out, 'device_paths.txt'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(sorted(self.paths)) + '\n')
        self.cache.save()
        print(f'built {self.content_name}: ' + ', '.join(f'{t} x{n}' for t, n in tracks) +
              f'; {C.mmss(self.END)}; {len(blob) / 1e6:.2f} MB -> {out}')
        for w in self.warn:
            print('WARNING:', w)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plan', required=True)
    ap.add_argument('--project', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--capcut-font', help="CapCut's own en.ttf (exact caption measuring); bundled font used otherwise")
    ap.add_argument('--font-path-in-draft', help='font path written into the draft (default: CapCut system font on Mac, '
                                                 'empty = CapCut default font on Windows)')
    a = ap.parse_args()
    b = Builder(a)
    b.build()
    b.write()


if __name__ == '__main__':
    main()
