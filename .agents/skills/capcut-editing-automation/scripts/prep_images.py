"""Download, normalise and review the generated images.

subcommands
  download  --list urls.txt --dir work/raw          lines "N URL" (N = shot number, or a name like sheetA)
  normalize --raw work/raw --shots work/timing/shots_timed.json --out work/shots --export "<media folder>"
            (the media folder = the folder the viewer imports, e.g. ~/Movies/CapCut Automation/<Video Name>/)
            makes every shot exactly 1920x1080 (centre crop, never stretched): PNG for analysis + JPG for CapCut,
            JPG names carry the timeline position: 07_0m21.0s.jpg
  contact   --dir work/shots --out work/review [--per 12] [--shots work/timing/shots_timed.json]
            labelled contact sheets so Claude (and the viewer) can check a whole batch at a glance
  split     --image sheet.png --n 5 --out work/refs
            auto-cut a character sheet into its N figures (left to right): refs/char_1.png ... + a labelled overview
  crop      --image sheet.png --box x0 y0 x1 y1 --out refs/hero.png [--pad 24]
            cut one character out by hand when split gets it wrong
"""
import argparse
import glob
import os
import re
import urllib.request
from PIL import Image, ImageDraw, ImageFont
import common as C

W, H = 1920, 1080


def sniff(data):
    """file extension from the first bytes (result URLs don't always end in one)"""
    h = data[:16]
    if h.startswith(b'\x89PNG'):
        return '.png'
    if h.startswith(b'\xff\xd8'):
        return '.jpg'
    if h.startswith(b'RIFF') and h[8:12] == b'WEBP':
        return '.webp'
    if h.startswith(b'RIFF') and h[8:12] == b'WAVE':
        return '.wav'
    if h.startswith(b'ID3') or h[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2'):
        return '.mp3'
    if h.startswith(b'OggS'):
        return '.ogg'
    if h[4:8] == b'ftyp':
        return '.mp4' if b'isom' in h or b'mp4' in h else '.m4a'
    return None


def cmd_download(a):
    os.makedirs(a.dir, exist_ok=True)
    ok = 0
    for line in open(a.list, encoding='utf-8'):
        parts = line.split()
        if len(parts) < 2:
            continue
        name, url = parts[0], parts[1]
        done = [p for p in glob.glob(os.path.join(a.dir, name + '.*')) if os.path.getsize(p) > 1000]
        if done and not a.force:
            ok += 1
            print(done[0])
            continue
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
            ext = sniff(data) or os.path.splitext(url.split('?')[0])[1] or '.bin'
            dst = os.path.join(a.dir, f'{name}{ext}')
            with open(dst, 'wb') as f:
                f.write(data)
            print(dst)
            ok += 1
        except Exception as e:
            print(f'FAILED {name}: {e}')
    print(f'{ok} files in {a.dir}')


def cover(im, w=W, h=H):
    im = im.convert('RGB')
    s = max(w / im.width, h / im.height)
    nw, nh = round(im.width * s), round(im.height * s)
    im = im.resize((nw, nh), Image.LANCZOS)
    x0, y0 = (nw - w) // 2, (nh - h) // 2
    return im.crop((x0, y0, x0 + w, y0 + h))


def find_raw(raw, n):
    """newest image for shot n: 7.png, 07.png, 7_r1.png, 07_r2.jpg ... (retakes win because they are newer)"""
    hits = set()
    for pat in (f'{n}.*', f'{int(n):02d}.*', f'{int(n):03d}.*', f'{n}_*.*', f'{int(n):02d}_*.*'):
        hits.update(p for p in glob.glob(os.path.join(raw, pat)) if p.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')))
    return sorted(hits, key=os.path.getmtime)[-1] if hits else None


def cmd_normalize(a):
    shots = C.load_json(a.shots)['shots']
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.export, exist_ok=True)
    # old shot JPGs (names carry timeline positions, which move when timing changes) would be imported twice
    for f in os.listdir(a.export):
        if re.match(r'^\d{2,3}_\d+m\d{2}\.\ds\.jpg$', f):
            os.remove(os.path.join(a.export, f))
    manifest, missing = [], []
    for r in shots:
        src = find_raw(a.raw, r['n'])
        if not src:
            missing.append(r['n'])
            continue
        im = cover(Image.open(src))
        png = os.path.join(a.out, f"{r['n']:02d}.png")
        im.save(png)
        t = round(r['start'], 1)
        name = f"{r['n']:02d}_{int(t // 60)}m{t % 60:04.1f}s.jpg"
        jpg = os.path.join(a.export, name)
        im.save(jpg, quality=92)
        manifest.append({'n': r['n'], 'png': os.path.abspath(png), 'jpg': os.path.abspath(jpg), 'source': src})
    C.save_json(os.path.join(a.out, 'manifest.json'), manifest)
    print(f'{len(manifest)} shots normalised to {W}x{H} -> {a.out} (PNG) and {a.export} (JPG)')
    if missing:
        print('MISSING raw images for shots:', missing)


def label_font(size):
    for p in (os.path.join(C.ASSETS, 'fonts', 'Metropolis-Medium.ttf'),):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def cmd_contact(a):
    files = sorted(glob.glob(os.path.join(a.dir, '*.png')) + glob.glob(os.path.join(a.dir, '*.jpg')))
    files = [f for f in files if not os.path.basename(f).startswith('contact')]
    info = {}
    if a.shots:
        for r in C.load_json(a.shots)['shots']:
            info[r['n']] = r
    os.makedirs(a.out, exist_ok=True)
    tw, th, cols = 480, 270, 4
    f = label_font(22)
    outs = []
    for k in range(0, len(files), a.per):
        chunk = files[k:k + a.per]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * tw + (cols + 1) * 8, rows * (th + 34) + 8), (30, 30, 30))
        d = ImageDraw.Draw(sheet)
        for i, p in enumerate(chunk):
            im = Image.open(p).convert('RGB')
            im.thumbnail((tw, th))
            x = 8 + (i % cols) * (tw + 8)
            y = 8 + (i // cols) * (th + 34)
            sheet.paste(im, (x, y + 30))
            m = re.match(r'(\d+)', os.path.basename(p))
            lab = os.path.basename(p)
            if m and int(m.group(1)) in info:
                r = info[int(m.group(1))]
                lab = f"#{r['n']}  {C.mmss(r['start'])}  {r['dur']:.1f}s"
            d.text((x + 2, y + 2), lab, fill=(255, 220, 90), font=f)
        o = os.path.join(a.out, f'contact_{k // a.per + 1:02d}.jpg')
        sheet.save(o, quality=88)
        outs.append(o)
    print('\n'.join(outs))


def cmd_crop(a):
    im = Image.open(a.image).convert('RGB')
    x0, y0, x1, y1 = a.box
    p = a.pad
    box = (max(0, x0 - p), max(0, y0 - p), min(im.width, x1 + p), min(im.height, y1 + p))
    c = im.crop(box)
    side = max(c.width, c.height)
    bg = Image.new('RGB', (side, side), c.getpixel((2, 2)))
    bg.paste(c, ((side - c.width) // 2, (side - c.height) // 2))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bg.save(a.out)
    print(a.out, bg.size)


def cmd_split(a):
    import numpy as np
    im = Image.open(a.image).convert('RGB')
    arr = np.asarray(im).astype(np.int16)
    h, w, _ = arr.shape
    corners = np.concatenate([arr[:20, :20].reshape(-1, 3), arr[:20, -20:].reshape(-1, 3),
                              arr[-20:, :20].reshape(-1, 3), arr[-20:, -20:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    mask = np.abs(arr - bg).sum(axis=2) > 60
    col = mask.sum(axis=0) > max(2, h * 0.004)
    segs, x = [], 0
    while x < w:
        if col[x]:
            x0 = x
            while x < w and col[x]:
                x += 1
            segs.append([x0, x])
        else:
            x += 1
    # join pieces separated by tiny gaps (an arm, a tail), then keep the N widest
    merged = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < w * 0.012:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    merged = sorted(sorted(merged, key=lambda s: s[1] - s[0], reverse=True)[:a.n])
    os.makedirs(a.out, exist_ok=True)
    over = im.copy()
    d = ImageDraw.Draw(over)
    f = label_font(max(18, w // 60))
    for i, (x0, x1) in enumerate(merged, 1):
        rows = np.where(mask[:, x0:x1].sum(axis=1) > 0)[0]
        y0, y1 = (int(rows[0]), int(rows[-1]) + 1) if len(rows) else (0, h)
        p = 24
        box = (max(0, x0 - p), max(0, y0 - p), min(w, x1 + p), min(h, y1 + p))
        c = im.crop(box)
        side = max(c.width, c.height)
        sq = Image.new('RGB', (side, side), tuple(int(v) for v in bg))
        sq.paste(c, ((side - c.width) // 2, (side - c.height) // 2))
        out = os.path.join(a.out, f'char_{i}.png')
        sq.save(out)
        d.rectangle(box, outline=(255, 0, 0), width=4)
        d.text((box[0] + 8, box[1] + 8), str(i), fill=(255, 0, 0), font=f)
        print(out, box)
    over.save(os.path.join(a.out, 'split_overview.jpg'), quality=85)
    if len(merged) < a.n:
        print(f'only found {len(merged)} figures; use crop with explicit boxes for the rest')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    d = sp.add_parser('download')
    d.add_argument('--list', required=True)
    d.add_argument('--dir', required=True)
    d.add_argument('--force', action='store_true')
    n = sp.add_parser('normalize')
    n.add_argument('--raw', required=True)
    n.add_argument('--shots', required=True)
    n.add_argument('--out', required=True)
    n.add_argument('--export', required=True)
    c = sp.add_parser('contact')
    c.add_argument('--dir', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--per', type=int, default=12)
    c.add_argument('--shots')
    q = sp.add_parser('split')
    q.add_argument('--image', required=True)
    q.add_argument('--n', type=int, required=True)
    q.add_argument('--out', required=True)
    k = sp.add_parser('crop')
    k.add_argument('--image', required=True)
    k.add_argument('--box', type=int, nargs=4, required=True)
    k.add_argument('--out', required=True)
    k.add_argument('--pad', type=int, default=24)
    a = ap.parse_args()
    {'download': cmd_download, 'normalize': cmd_normalize, 'contact': cmd_contact, 'crop': cmd_crop,
     'split': cmd_split}[a.cmd](a)


if __name__ == '__main__':
    main()
