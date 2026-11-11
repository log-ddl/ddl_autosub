"""Đường dẫn và tiện ích dùng chung cho core/tools/*.py. Mọi lệnh nhận <id> và chỉ làm việc trong projects/<id>/ (khung: README.md)."""
import json
import os
import re
import shutil
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'remotion'
KIT = ROOT / 'core/kit'
SKILLS = ROOT / 'skills'
LIBRARY = ROOT / 'library'
PROJECTS = ROOT / 'projects'
NPX = 'npx'

CHAPTER_ID = r'C\d{2}'
SCENE_ID = r'C\d{2}S\d{2,3}'
TRANSITIONS = ('cut', 'fade', 'slide', 'wipe', 'flip', 'clockWipe')
MOVES = ('zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'none')


def project(pid: str) -> Path:
    if not re.fullmatch(r'[a-z][a-z0-9_]*', pid or ''):
        sys.exit('id chỉ gồm chữ thường, số, gạch dưới và bắt đầu bằng chữ')
    return PROJECTS / pid


def need(pid: str) -> Path:
    p = project(pid)
    if not (p / 'project.json').exists():
        sys.exit(f'chưa có dự án projects/{pid} (tạo bằng core/tools/new.py)')
    return p


def comp_id(pid: str) -> str:
    return pid.replace('_', '-')


def studio_port(pid: str) -> int:
    """Port Studio cố định theo id để nhiều dự án mở cùng lúc không đụng nhau."""
    return 3100 + zlib.crc32(pid.encode()) % 1800


def probe(path: Path) -> float:
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True).stdout.strip()
    try:
        return round(float(out), 3)
    except ValueError:
        return 0.0


def probe_size(path: Path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                          '-of', 'csv=p=0:s=x', str(path)], capture_output=True, text=True).stdout.strip()
    m = re.match(r'(\d+)x(\d+)', out)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def load(path: Path):
    return json.loads(path.read_text())


def write_if_changed(path: Path, text: str):
    """Ghi nguyên tử và chỉ khi nội dung đổi (nhiều tiến trình check có thể gọi cùng lúc)."""
    if path.exists() and path.read_text() == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.tmp_{os.getpid()}_{path.name}')
    tmp.write_text(text)
    os.replace(tmp, path)


def save_json(path: Path, data):
    write_if_changed(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def opt(argv, key, default=None, cast=str):
    return cast(argv[argv.index(key) + 1]) if key in argv else default


# ---------------------------------------------------------------- plan: chương → cảnh → timeline

def chapters(pdir: Path) -> list:
    """plan/chapters/CNN.json đã kiểm: chương nối liền, cảnh phủ đúng chương, cảnh liền mạch, trường theo loại cảnh."""
    out = [load(f) for f in sorted((pdir / 'plan/chapters').glob('C[0-9][0-9].json'))]
    if not out:
        sys.exit('chưa có chương nào trong plan/chapters/ (CNN.json)')
    for i, c in enumerate(out):
        cid = c.get('id', '')
        if not re.fullmatch(CHAPTER_ID, cid):
            sys.exit(f'id chương phải dạng C01: {cid!r}')
        if c['to'] <= c['from']:
            sys.exit(f'{cid}: to <= from')
        if i and abs(c['from'] - out[i - 1]['to']) > 1e-6:
            sys.exit(f"{cid}: from {c['from']} không nối với to {out[i - 1]['to']} của {out[i - 1]['id']}")
        sc = c.get('scenes') or []
        for k, s in enumerate(sc):
            sid = s.get('id', '')
            if not re.fullmatch(SCENE_ID, sid) or not sid.startswith(cid + 'S'):
                sys.exit(f'{cid}: id cảnh phải dạng {cid}S01, gặp {sid!r}')
            if s['to'] <= s['from']:
                sys.exit(f'{sid}: to <= from')
            if k and abs(s['from'] - sc[k - 1]['to']) > 1e-6:
                sys.exit(f"{sid}: from {s['from']} không nối với to {sc[k - 1]['to']} của {sc[k - 1]['id']}")
            typ = s.get('type', 'code')
            if typ not in ('code', 'clip', 'still'):
                sys.exit(f'{sid}: type phải là code / clip / still, gặp {typ!r}')
            if typ != 'code' and not s.get('asset'):
                sys.exit(f'{sid}: cảnh {typ} cần "asset"')
            if typ == 'still' and s.get('move', 'zoom-in') not in MOVES:
                sys.exit(f"{sid}: move phải là một trong {', '.join(MOVES)}")
            if s.get('transition', 'fade').partition(':')[0] not in TRANSITIONS:
                sys.exit(f"{sid}: transition không hỗ trợ {s['transition']!r} (có: {', '.join(TRANSITIONS)})")
        if sc and (abs(sc[0]['from'] - c['from']) > 1e-6 or abs(sc[-1]['to'] - c['to']) > 1e-6):
            sys.exit(f"{cid}: cảnh phải phủ đúng {c['from']}–{c['to']} (đang {sc[0]['from']}–{sc[-1]['to']})")
    ids = [s['id'] for c in out for s in c.get('scenes') or []]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        sys.exit(f'id cảnh trùng: {dup}')
    return out


def timeline(pdir: Path) -> dict:
    """Gộp các chương thành timeline. Chương chưa plan → một cảnh giữ chỗ CNNS01 phủ cả chương."""
    proj = load(pdir / 'project.json')
    chs = chapters(pdir)
    scenes = []
    for c in chs:
        sc = c.get('scenes') or [{'id': f"{c['id']}S01", 'from': c['from'], 'to': c['to'], 'type': 'code', 'pending': True}]
        scenes += [dict(s, chapter=c['id'], type=s.get('type', 'code')) for s in sc]
    return {'id': proj['id'], 'width': proj['width'], 'height': proj['height'], 'fps': proj['fps'],
            'duration': chs[-1]['to'],
            'chapters': [{k: c[k] for k in ('id', 'from', 'to') if k in c} | {'title': c.get('title', '')} for c in chs],
            'scenes': scenes,
            'sfx': [x for c in chs for x in c.get('sfx') or []]
                   + [x for f in sorted((pdir / 'plan/sfx').glob('*.json')) for x in load(f).get('sfx', [])],
            'volume': {'music': 0.4, 'sfx': 0.5} | {k: v for k, v in mix_volume(pdir).items() if k in ('music', 'sfx')}}


def mix_volume(pdir: Path) -> dict:
    f = pdir / 'plan/mix.json'
    return load(f).get('volume', {}) if f.exists() else {}


def sync_cues(pdir: Path):
    """src/cues/CNN.ts (+ file .ts khác, ví dụ film.ts) → src/cues/index.ts gộp tất cả thành CUE."""
    d = pdir / 'src/cues'
    files = sorted(f for f in d.glob('*.ts') if f.stem != 'index') if d.is_dir() else []
    seen = {}
    for f in files:
        for k in re.findall(r'^\s*([A-Za-z_]\w*)\s*:', f.read_text(), re.M):
            if k in seen:
                sys.exit(f'CUE trùng tên "{k}" ở cues/{seen[k]} và cues/{f.name}')
            seen[k] = f.name
    alias = [f'cue_{f.stem}' for f in files]
    write_if_changed(d / 'index.ts',
                     '// SINH TỰ ĐỘNG từ src/cues/*.ts (core/tools) — không sửa tay; sửa file chương.\n'
                     + ''.join(f"import {{ CUE as {a} }} from './{f.stem}';\n" for a, f in zip(alias, files))
                     + f"\nexport const CUE = {{ {', '.join('...' + a for a in alias)} }} as const;\n")


# ---------------------------------------------------------------- tài sản

def assets(pdir: Path) -> dict:
    return {a['id']: a for a in load(pdir / 'assets/ASSETS.json')['assets']}


def asset_refs(pdir: Path, files=None) -> dict:
    """Mã tài sản gọi trong code: {mã: [nơi dùng]} (nơi dùng = id cảnh, hoặc đường dẫn trong src/)."""
    refs = {}
    for f in files if files is not None else (pdir / 'src').rglob('*.ts*'):
        if f.is_file():
            where = f.stem if f.parent.name == 'scenes' else str(f.relative_to(pdir / 'src'))
            for a in re.findall(r"asset(?:Info)?\(\s*['\"](a\d{3,})['\"]\s*\)", f.read_text()):
                refs.setdefault(a, []).append(where)
    return refs


def link_file(src: Path, dst: Path):
    """Đưa file vào .build/public: hard link (không tốn chỗ), không được thì chép. Chỉ làm lại khi nguồn mới hơn."""
    if dst.exists() and dst.stat().st_mtime >= src.stat().st_mtime and dst.stat().st_size == src.stat().st_size:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f'.tmp_{os.getpid()}_{dst.name}')
    try:
        os.link(src, tmp)
    except OSError:
        shutil.copy2(src, tmp)
    os.replace(tmp, dst)


def sync_assets(pdir: Path, ids) -> list:
    """Đưa các tài sản `ids` vào .build/public/assets/ và ghi .build/assets.ts. Trả về danh sách lỗi."""
    reg, errs, table = assets(pdir), [], {}
    for i in sorted(set(ids)):
        a = reg.get(i)
        if not a:
            errs.append(f'{i}: không có trong assets/ASSETS.json')
            continue
        f = pdir / 'assets' / a.get('file', '')
        if a.get('status') != 'have' or not a.get('file') or not f.is_file():
            errs.append(f"{i}: chưa có file ({a.get('want') or a.get('file') or 'status need'})")
            continue
        pub = f'assets/{i}{f.suffix.lower()}'
        link_file(f, pdir / '.build/public' / pub)
        table[i] = {'file': pub, 'kind': a['kind']} | {k: a[k] for k in ('width', 'height', 'duration', 'tags') if a.get(k)}
    write_if_changed(pdir / '.build/assets.ts',
                     '// SINH TỰ ĐỘNG bởi core/tools — sổ tài sản cho asset(). Import đầu tiên trong entry.\n'
                     "import { registerAssets } from '@core/asset';\n\n"
                     f'registerAssets({json.dumps(table, ensure_ascii=False, indent=2)});\n')
    return errs


# ---------------------------------------------------------------- TypeScript và Remotion

def skill_libs() -> dict:
    return {d.name: d / 'lib' for d in sorted(SKILLS.iterdir()) if (d / 'lib').is_dir()} if SKILLS.is_dir() else {}


def write_tsconfig(path: Path, include: list, extra: dict = None):
    """tsconfig có đủ alias @core/*, @skill/<tên>/* (paths tính tương đối với file này)."""
    def rel(p):
        r = Path(os.path.relpath(p, path.parent)).as_posix()
        return r if r.startswith('.') else './' + r
    paths = {'@core/*': [rel(KIT) + '/*']} | {f'@skill/{n}/*': [rel(lib) + '/*'] for n, lib in skill_libs().items()}
    cfg = {'extends': rel(RUNTIME / 'tsconfig.base.json'), 'compilerOptions': {'paths': paths} | (extra or {}), 'include': include}
    write_if_changed(path, json.dumps(cfg, indent=2) + '\n')


def tsc(config: Path) -> list:
    r = subprocess.run([str(RUNTIME / 'node_modules/.bin/tsc'), '-p', str(config)], capture_output=True, text=True)
    return [ln for ln in (r.stdout + r.stderr).splitlines() if 'error TS' in ln]


def remotion(args, **kw):
    """Chạy CLI Remotion từ remotion/ (để nhận remotion.config.ts)."""
    return subprocess.run([NPX, 'remotion', *args], cwd=RUNTIME, **kw)


TRANS = {
    'fade': ("fade()", "import { fade } from '@remotion/transitions/fade';"),
    'slide': ("slide({{ direction: '{d}' }})", "import { slide } from '@remotion/transitions/slide';"),
    'wipe': ("wipe({{ direction: '{d}' }})", "import { wipe } from '@remotion/transitions/wipe';"),
    'flip': ("flip({{ direction: '{d}' }})", "import { flip } from '@remotion/transitions/flip';"),
    'clockWipe': ("clockWipe({{ width: {w}, height: {h} }})", "import { clockWipe } from '@remotion/transitions/clock-wipe';"),
}


def transition(s: str, w: int, h: int):
    """'fade' (mặc định) | 'cut' | 'slide:from-right' | 'wipe:from-left' | 'flip:from-top' | 'clockWipe' → (biểu thức TS, import)."""
    kind, _, d = (s or 'fade').partition(':')
    if kind == 'cut':
        return 'null', None
    expr, imp = TRANS[kind]
    return expr.format(d=d or 'from-right', w=w, h=h), imp


def scene_spec_ts(s: dict, comp: str, w: int, h: int):
    """Một phần tử SceneSpec dạng TS; comp = tên component (hoặc None)."""
    expr, imp = transition(s.get('transition', 'fade'), w, h)
    f = [f"id: '{s['id']}'", f"from: {s['from']:g}", f"to: {s['to']:g}", f"type: '{s['type']}'"]
    if comp:
        f.append(f'C: {comp}')
    if s.get('asset'):
        f.append(f"asset: '{s['asset']}'")
    if s['type'] == 'clip':
        f.append(f"in: {s.get('in', 0):g}")
        if s.get('volume'):
            f.append(f"volume: {s['volume']:g}")
    if s['type'] == 'still':
        f.append(f"move: '{s.get('move', 'zoom-in')}'")
    f.append(f'transition: {expr}')
    return '{ ' + ', '.join(f) + ' }', imp
