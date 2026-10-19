"""Render a QA preview of the BUILT draft (reads the draft file itself, not the plan).

usage: python3 preview.py --build work/build --out work/preview/preview [--stills] [--audio-only] [--width 960]

Video: every shot with its keyframed zoom, every caption with its pop-in, at 30 fps.
Audio: every audio clip with its source range, volume / volume keyframes and fades, mixed like CapCut
(mono files at unity in both channels). Prints the mix peak and loudness and writes:
  <out>.mp4             the preview to send to the viewer
  <out>_stills/*.jpg    (--stills) one frame 0.3 s after every caption appears, plus a contact sheet,
                        so the captions can be checked against the pictures
"""
import argparse
import json
import os
import subprocess
import numpy as np
from PIL import Image
import common as C
import textfit

SR = 48000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--build', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--stills', action='store_true')
    ap.add_argument('--audio-only', action='store_true')
    ap.add_argument('--stills-only', action='store_true', help='skip the video, just the caption stills (fast)')
    ap.add_argument('--width', type=int, default=960)
    a = ap.parse_args()

    rep = C.load_json(os.path.join(a.build, 'build_report.json'))
    D = C.load_json(os.path.join(a.build, rep['content_name']))
    textfit.set_font(rep['measure_font'] if 'Metropolis' not in rep['measure_font'] else None)
    FPS = rep['fps']
    W = a.width
    H = W * 1080 // 1920
    d2l = rep['device_to_local']
    idx = {x['id']: (k, x) for k, v in D['materials'].items() if isinstance(v, list) for x in v
           if isinstance(x, dict) and 'id' in x}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)

    def local(p):
        if p not in d2l:
            C.die(f'no local copy known for {p}')
        return d2l[p]

    def kf_value(seg, prop, t_us, default):
        for k in seg.get('common_keyframes', []):
            if k['property_type'] == prop:
                xs = [p['time_offset'] for p in k['keyframe_list']]
                ys = [p['values'][0] for p in k['keyframe_list']]
                return float(np.interp(t_us, xs, ys))
        return default

    # ------------------------------------------------------------ audio
    total = int(D['duration'] / 1e6 * SR)
    mix = np.zeros((total + SR, 2), np.float32)
    cache = {}
    for tr in D['tracks']:
        if tr['type'] != 'audio':
            continue
        for s in tr['segments']:
            m = idx[s['material_id']][1]
            p = local(m['path'])
            if p not in cache:
                cache[p] = C.decode(p, SR, stereo=True)
            src0 = int(s['source_timerange']['start'] / 1e6 * SR)
            n = int(s['target_timerange']['duration'] / 1e6 * SR)
            dst0 = int(s['target_timerange']['start'] / 1e6 * SR)
            clip = cache[p][src0:src0 + n].copy()
            n = len(clip)
            t_us = np.arange(n) / SR * 1e6
            vk = [k for k in s.get('common_keyframes', []) if k['property_type'] == 'KFTypeVolume']
            if vk:
                g = np.interp(t_us, [q['time_offset'] for q in vk[0]['keyframe_list']],
                              [q['values'][0] for q in vk[0]['keyframe_list']])
            else:
                g = np.full(n, s.get('volume', 1.0))
            for r in s['extra_material_refs']:
                if idx[r][0] == 'audio_fades':
                    f = idx[r][1]
                    fi = int(f['fade_in_duration'] / 1e6 * SR)
                    fo = int(f['fade_out_duration'] / 1e6 * SR)
                    if 0 < fi < n:
                        g[:fi] *= np.linspace(0, 1, fi)
                    if 0 < fo < n:
                        g[-fo:] *= np.linspace(1, 0, fo)
            mix[dst0:dst0 + n] += clip * g[:, None].astype(np.float32)
    mix = mix[:total]
    pi = int(np.argmax(np.abs(mix).max(axis=1)))
    peak = 20 * np.log10(np.abs(mix[pi]).max() + 1e-9)
    lufs = C.lufs_integrated(mix, SR)
    pt = pi / SR
    playing = []
    for tr in D['tracks']:
        if tr['type'] != 'audio':
            continue
        for s in tr['segments']:
            a0 = s['target_timerange']['start'] / 1e6
            if a0 <= pt < a0 + s['target_timerange']['duration'] / 1e6:
                playing.append(os.path.basename(idx[s['material_id']][1]['path'].replace('\\', '/')))
    print(f'mix: peak {peak:.2f} dBFS at {pt:.2f}s ({", ".join(playing)}), loudness {lufs:.1f} LUFS')
    if peak > -0.5:
        print('WARNING: the mix peaks above -0.5 dBFS; lower the clip(s) playing at that moment '
              '(an effect\'s level, or the music target_lufs)')
    mixf = a.out + '_mix.f32'
    mix.astype(np.float32).tofile(mixf)
    if a.audio_only:
        subprocess.run([C.ffmpeg(), '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', mixf,
                        '-c:a', 'aac', '-b:a', '192k', a.out + '.m4a'], check=True)
        os.remove(mixf)
        print('audio ->', a.out + '.m4a')
        return

    # ------------------------------------------------------------ video
    vsegs = D['tracks'][0]['segments']
    tsegs = [s for tr in D['tracks'] if tr['type'] == 'text' for s in tr['segments']]
    lays = rep['layouts']
    lay_by = {}
    for s in tsegs:
        c = json.loads(idx[s['material_id']][1]['content'])['text']
        st = s['target_timerange']['start']
        L = min((L for L in lays if '\n'.join(L['lines']) == c), key=lambda L: abs(L['start'] * 1e6 - st))
        L = dict(L)
        L['color'] = tuple(L['color'])
        L['sub_color'] = tuple(L['sub_color']) if L['sub_color'] else None
        lay_by[s['id']] = L
    text_cache, imgs = {}, {}

    def text_layer(L, scale, key):
        k = (key, round(scale, 2))
        if k not in text_cache:
            canvas = Image.new('RGBA', (1920, 1080), (0, 0, 0, 0))
            textfit.render_text(canvas, L, scale=scale)
            text_cache[k] = canvas.resize((W, H), Image.LANCZOS)
        return text_cache[k]

    def frame_at(t_us, vi_hint=0):
        vi = vi_hint
        while vi + 1 < len(vsegs) and vsegs[vi + 1]['target_timerange']['start'] <= t_us + 1:
            vi += 1
        s = vsegs[vi]
        p = local(idx[s['material_id']][1]['path'])
        if p not in imgs:
            imgs[p] = Image.open(p).convert('RGB')
        im = imgs[p]
        off = t_us - s['target_timerange']['start']
        sc = kf_value(s, 'KFTypeScaleX', off, s['clip']['scale']['x'])
        bw, bh = im.width / sc, im.height / sc
        x0, y0 = (im.width - bw) / 2, (im.height - bh) / 2
        fr = im.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + bw, y0 + bh)).convert('RGBA')
        for ts in tsegs:
            st = ts['target_timerange']['start']
            du = ts['target_timerange']['duration']
            if st <= t_us < st + du:
                tsc = kf_value(ts, 'KFTypeScaleX', t_us - st, 1.0)
                fr.alpha_composite(text_layer(lay_by[ts['id']], tsc, ts['id']))
        return fr.convert('RGB'), vi

    nframes = int(round(D['duration'] / 1e6 * FPS))
    if a.stills_only:
        a.stills = True
        nframes = 0
    ff = None if a.stills_only else subprocess.Popen([C.ffmpeg(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                           '-r', str(FPS), '-i', '-', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', mixf,
                           '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
                           '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', a.out + '.mp4'],
                          stdin=subprocess.PIPE)
    vi = 0
    for f in range(nframes):
        fr, vi = frame_at(f * 1e6 / FPS, vi)
        ff.stdin.write(fr.tobytes())
    if ff:
        ff.stdin.close()
        ff.wait()
        print(f'preview -> {a.out}.mp4 ({nframes} frames)')
    os.remove(mixf)

    if a.stills:
        sd = a.out + '_stills'
        os.makedirs(sd, exist_ok=True)
        for f in os.listdir(sd):
            if f.endswith('.jpg'):
                os.remove(os.path.join(sd, f))
        outs = []
        for k, ts in enumerate(sorted(tsegs, key=lambda s: s['target_timerange']['start'])):
            t_us = ts['target_timerange']['start'] + min(300000, ts['target_timerange']['duration'] // 2)
            fr, _ = frame_at(t_us)
            p = os.path.join(sd, f"{k + 1:02d}_{t_us / 1e6:07.2f}s.jpg")
            fr.save(p, quality=88)
            outs.append(p)
        # contact sheets of the stills, 12 per sheet
        tw, th, cols = 480, 270, 4
        for s0 in range(0, len(outs), 12):
            chunk = outs[s0:s0 + 12]
            rows = (len(chunk) + cols - 1) // cols
            sheet = Image.new('RGB', (cols * tw, rows * th), (0, 0, 0))
            for i, p in enumerate(chunk):
                im = Image.open(p)
                im.thumbnail((tw, th))
                sheet.paste(im, ((i % cols) * tw, (i // cols) * th))
            sheet.save(os.path.join(sd, f'captions_{s0 // 12 + 1:02d}.jpg'), quality=85)
        print(f'{len(outs)} caption stills -> {sd} (contact sheets captions_*.jpg)')


if __name__ == '__main__':
    main()
