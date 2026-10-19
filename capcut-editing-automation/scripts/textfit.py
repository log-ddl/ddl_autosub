"""Caption sizing and placement so every on-screen text fits the frame and avoids the busy parts of the image.

Font model (measured against CapCut's own render): CapCut's default system font is Metropolis Medium
(en.ttf). Rendered em height in px on a 1920x1080 canvas = 10.85 * font size * scale; stroke 0.08 em;
line gap 0.02 em. Keyframed scale REPLACES clip scale in CapCut, so the clip scale stays 1.0 and the
pop-in peaks at POP_MAX; every fit check is done at that peak.

Measurement font: CapCut's real en.ttf when available (pass its path to set_font), otherwise the bundled
public-domain Metropolis Medium with a 7% width safety margin (its spacing is slightly tighter).
"""
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ASSETS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
EM_PER_SIZE = 10.85
STROKE = 0.08
LINE_GAP = 0.02
POP_MAX = 1.06
CW, CH = 1920, 1080
MX, MY = 96, 54          # 5% title-safe margins
NO_WRAP_W = 1450         # well under CapCut's line_max_width 0.82 (1574 px) so nothing auto-wraps

COLORS = {'yellow': (1.0, 0.84, 0.26), 'white': (1.0, 1.0, 1.0), 'red': (0.93, 0.23, 0.2),
          'green': (0.36, 0.85, 0.42), 'blue': (0.35, 0.67, 1.0), 'orange': (1.0, 0.6, 0.2), 'black': (0.0, 0.0, 0.0)}

STYLES = {
    # rows = where the caption may sit (it slides sideways to find a clear spot); pref = preferred spot
    # number / statistic callout
    'num':   {'size': 12.0, 'color': 'yellow', 'rows': ['top', 'bottom'], 'pref': ('center', 'top')},
    # one huge word
    'big':   {'size': 17.0, 'color': 'yellow', 'rows': ['top', 'bottom'], 'pref': ('center', 'top')},
    # place, date, chapter label
    'label': {'size': 9.0, 'color': 'white', 'rows': ['top', 'bottom'], 'pref': ('center', 'top')},
    # title card (sits in the right-hand side of the frame unless pos/box given)
    'title': {'size': 15.0, 'color': 'white', 'box': (1170, 110, 1830, 930)},
    # short quote
    'quote': {'size': 8.5, 'color': 'white', 'rows': ['top', 'bottom'], 'pref': ('center', 'top')},
    # name + role lower third (sub line in yellow)
    'lower': {'size': 7.0, 'color': 'white', 'sub_size': 4.8, 'sub_color': 'yellow',
              'rows': ['bottom', 'top'], 'pref': ('left', 'bottom')},
    # rubber-stamp word, tilted
    'stamp': {'size': 13.0, 'color': 'red', 'rot': -8.0, 'rows': ['top', 'middle', 'bottom'], 'pref': ('right', 'top')},
    # year / small number in a corner region
    'year':  {'size': 11.0, 'color': 'yellow', 'box': (0, 60, 630, 330)},
    # end-screen call to action (bottom right)
    'cta':   {'size': 11.0, 'color': 'yellow', 'box': (900, 600, 1824, 1026)},
}

_font = {'path': None, 'safety': 1.07, 'F': None}


def set_font(capcut_en_ttf=None):
    """Use CapCut's own en.ttf if we have it (exact), else the bundled Metropolis (+7% safety)."""
    if capcut_en_ttf and os.path.exists(capcut_en_ttf):
        _font.update(path=capcut_en_ttf, safety=1.0)
    else:
        _font.update(path=os.path.join(ASSETS, 'fonts', 'Metropolis-Medium.ttf'), safety=1.07)
    _font['F'] = ImageFont.truetype(_font['path'], 1000)
    return _font['path']


def color(c):
    if c is None:
        return None
    if isinstance(c, (list, tuple)):
        return tuple(float(x) for x in c)
    c = str(c).strip()
    if c.startswith('#') and len(c) == 7:
        return tuple(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))
    if c.lower() in COLORS:
        return COLORS[c.lower()]
    raise ValueError(f'unknown colour {c!r}')


def line_w_em(s):
    if _font['F'] is None:
        set_font()
    return _font['F'].getlength(s) / 1000.0 * _font['safety']


def block_dims(lines, sizes):
    ems = [EM_PER_SIZE * s for s in sizes]
    w = max(line_w_em(l) * em for l, em in zip(lines, ems)) + 2 * STROKE * max(ems)
    h = sum(ems) + LINE_GAP * sum(ems[1:])
    return w, h, ems


def rotated_extent(w, h, deg):
    r = math.radians(abs(deg))
    return w * math.cos(r) + h * math.sin(r), w * math.sin(r) + h * math.cos(r)


def anchor_center(cand, bw, bh):
    pad = 16
    x = {'left': MX + pad + bw / 2, 'right': CW - MX - pad - bw / 2, 'center': CW / 2}
    y = {'top': MY + pad + bh / 2, 'bottom': CH - MY - pad - bh / 2, 'middle': CH / 2}
    if cand in ('top', 'bottom'):
        return CW / 2, y[cand]
    if cand == 'center':
        return CW / 2, CH / 2
    if cand in ('left', 'right'):
        return x[cand], CH / 2
    v, hz = cand.split('-')
    return x[hz], y[v]


_ink = {}


def ink_map(img_path):
    """Foreground map of a flat illustration: dark strokes plus every region they fully enclose
    (faces, bodies, props), so captions avoid characters even where they are white inside."""
    if img_path not in _ink:
        from scipy import ndimage
        im = Image.open(img_path).convert('L')
        if im.size != (CW, CH):
            im = im.resize((CW, CH))
        small = im.resize((CW // 4, CH // 4), Image.BILINEAR)
        g = np.asarray(small).astype(np.float32)
        ed = np.asarray(small.filter(ImageFilter.FIND_EDGES)).astype(np.float32)
        strokes = (g < 110) | (ed > 60)
        strokes = ndimage.binary_dilation(strokes, iterations=1)
        free = np.pad(~strokes, 1, constant_values=True)     # a free ring around the frame joins all edge regions
        lab, n = ndimage.label(free)
        lab = lab[1:-1, 1:-1]
        outer = lab[0, 0] if n else 0
        sizes = ndimage.sum(np.ones_like(lab), lab, index=np.arange(n + 1))
        enclosed = np.zeros(n + 1, bool)
        for k in range(1, n + 1):
            # small closed shapes = characters, faces, props; big open areas (sky, ground, walls) stay free
            if k != outer and sizes[k] < 0.12 * lab.size:
                enclosed[k] = True
        fg = strokes | enclosed[lab]
        fg = ndimage.binary_dilation(fg, iterations=3)          # ~12 px breathing room around characters
        _ink[img_path] = np.asarray(Image.fromarray((fg * 255).astype(np.uint8)).resize((CW, CH))) / 255.0
    return _ink[img_path]


_integ = {}


def _ii(img_path):
    if img_path not in _integ:
        m = ink_map(img_path)
        _integ[img_path] = np.pad(m.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    return _integ[img_path]


def _mean(I, x0, y0, x1, y1):
    a = (x1 - x0) * (y1 - y0)
    return (I[y1, x1] - I[y0, x1] - I[y1, x0] + I[y0, x0]) / a if a > 0 else 0.0


def busy(img_path, cx, cy, bw, bh):
    """how much of the box covers drawing: mean coverage blended with its worst third, so a head
    poking into one end of a wide caption still counts"""
    if not img_path:
        return 0.0
    I = _ii(img_path)
    x0, x1 = int(max(0, cx - bw / 2)), int(min(CW, cx + bw / 2))
    y0, y1 = int(max(0, cy - bh / 2)), int(min(CH, cy + bh / 2))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    xs = np.linspace(x0, x1, 4).astype(int)
    worst = max(_mean(I, xs[i], y0, xs[i + 1], y1) for i in range(3) if xs[i + 1] > xs[i])
    return float(0.5 * _mean(I, x0, y0, x1, y1) + 0.5 * worst)


MIN_AUTO_SIZE = 6.5      # auto placement never shrinks a caption's main line below this (about 70 px tall)


def best_spot(st, img_path, bw, bh, size=None):
    """slide the caption along its allowed rows (and try it up to 45% smaller, never below MIN_AUTO_SIZE)
    to find the clearest spot"""
    pad = 16
    prefx, prefy = st.get('pref', ('center', 'top'))
    best = None
    scales = [f for f in (1.0, 0.85, 0.7, 0.55) if f == 1.0 or not size or size * f >= MIN_AUTO_SIZE]
    for step, f in enumerate(scales):
        sw, sh = bw * f, bh * f
        for r, row in enumerate(st['rows']):
            cy = {'top': MY + pad + sh / 2, 'bottom': CH - MY - pad - sh / 2, 'middle': CH / 2}[row]
            lo, hi = MX + pad + sw / 2, CW - MX - pad - sw / 2
            xs = [CW / 2] if hi <= lo else list(np.arange(lo, hi + 1, 32)) + [hi]
            px = {'left': lo, 'center': CW / 2, 'right': hi}[prefx]
            for cx in xs:
                score = 2.0 * busy(img_path, cx, cy, sw, sh) + 0.05 * step + (0.0 if row == prefy else 0.02) \
                    + 0.02 * abs(cx - px) / (CW / 2)
                if best is None or score < best[0]:
                    best = (score, f'{row} x={cx:.0f}', cx, cy, f)
        if best[0] < 0.06 + 0.05 * step:
            break
    return best


def layout(tx, img_path=None):
    """tx: {"text","style","pos","size","color","rot","sub","box"} -> layout dict with fits flag.

    pos: "auto" (least busy of the style's candidate anchors), an anchor name ("top", "bottom-left", ...),
         or [x, y] = centre in pixels on the 1920x1080 frame (clamped inside the margins).
    """
    st = STYLES[tx.get('style', 'label')]
    lines = str(tx['text']).split('\n')
    size = float(tx.get('size') or st['size'])
    sub = tx.get('sub')
    rot = float(tx['rot']) if tx.get('rot') is not None else st.get('rot', 0.0)
    pos = tx.get('pos', 'auto') or 'auto'
    box = tx.get('box') or st.get('box')
    shrunk = 0
    while True:
        if sub:
            all_lines = lines + [sub]
            sizes = [size] * len(lines) + [st.get('sub_size', st['size'] * 0.68) * size / st['size']]
        else:
            all_lines, sizes = lines, [size] * len(lines)
        w1, h1, ems = block_dims(all_lines, sizes)
        bw, bh = rotated_extent(w1 * POP_MAX, h1 * POP_MAX, rot)
        limit_w, limit_h = CW - 2 * MX - 32, CH - 2 * MY - 32
        if box and pos == 'auto':
            bx0, by0, bx1, by1 = box
            limit_w, limit_h = (bx1 - bx0) * 0.92, (by1 - by0) * 0.92
        if (w1 <= NO_WRAP_W and bw <= limit_w and bh <= limit_h) or size <= 2.0:
            break
        size = round(size - 0.25, 2)
        shrunk += 1
    if isinstance(pos, (list, tuple)):
        cx, cy = float(pos[0]), float(pos[1])
        choice = 'fixed'
    elif pos != 'auto':
        cx, cy = anchor_center(pos, bw, bh)
        choice = pos
    elif box:
        bx0, by0, bx1, by1 = box
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        choice = 'box'
    else:
        _, choice, cx, cy, f = best_spot(st, img_path, bw, bh, size)
        if f < 1.0:
            size = round(size * f, 2)
            sizes = [s * f for s in sizes]
            w1, h1, bw, bh = w1 * f, h1 * f, bw * f, bh * f
            shrunk += 1
    # keep the whole box (at the pop-in peak) inside the 5% margins
    cx = min(max(cx, MX + bw / 2), CW - MX - bw / 2)
    cy = min(max(cy, MY + bh / 2), CH - MY - bh / 2)
    x0, x1, y0, y1 = cx - bw / 2, cx + bw / 2, cy - bh / 2, cy + bh / 2
    fits = x0 >= MX - 0.5 and x1 <= CW - MX + 0.5 and y0 >= MY - 0.5 and y1 <= CH - MY + 0.5
    col = color(tx.get('color')) or color(st['color'])
    sub_col = color(st.get('sub_color')) if sub else None
    return {'text': tx['text'], 'style': tx.get('style', 'label'), 'size_final': size, 'sizes': sizes,
            'lines': all_lines, 'n_main': len(lines), 'rot': rot, 'cx': cx, 'cy': cy, 'bw': bw, 'bh': bh,
            'w1': w1, 'h1': h1, 'choice': choice, 'fits': fits, 'shrunk': shrunk,
            'busy': round(busy(img_path, cx, cy, bw, bh), 3),
            'tx': (cx - CW / 2) / (CW / 2), 'ty': (CH / 2 - cy) / (CH / 2),
            'color': col, 'sub_color': sub_col}


def render_text(canvas, L, scale=POP_MAX):
    """Approximate CapCut's render of one caption onto a 1920x1080 RGBA canvas (preview/QA only)."""
    if _font['F'] is None:
        set_font()
    layer = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ems = [EM_PER_SIZE * s * scale for s in L['sizes']]
    total_h = sum(ems) + LINE_GAP * sum(ems[1:])
    y = L['cy'] - total_h / 2
    for i, (line, em) in enumerate(zip(L['lines'], ems)):
        f = ImageFont.truetype(_font['path'], max(1, int(round(em))))
        wl = f.getlength(line) * _font['safety']
        col = L['color'] if i < L['n_main'] else (L['sub_color'] or L['color'])
        rgb = tuple(int(c * 255) for c in col)
        d.text((L['cx'] - wl / 2, y), line, font=f, fill=rgb + (255,),
               stroke_width=max(1, int(round(STROKE * em))), stroke_fill=(0, 0, 0, 255))
        y += em * (1 + LINE_GAP)
    if L['rot']:
        layer = layer.rotate(-L['rot'], center=(L['cx'], L['cy']), resample=Image.BICUBIC)
    canvas.alpha_composite(layer)
    return canvas
