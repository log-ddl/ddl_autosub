#!/usr/bin/env python3
"""Nâng Remotion và tải tài liệu chính thức đúng bản về remotion/docs/ (skills/ + docs/ của repo remotion-dev/remotion).

    python3 core/tools/upgrade.py              chỉ tải lại tài liệu cho bản đang dùng
    python3 core/tools/upgrade.py 4.0.560      đổi mọi gói remotion, @remotion/* sang bản này, cài lại, tải tài liệu
    python3 core/tools/upgrade.py latest       như trên với bản mới nhất trên npm

Sau khi nâng: build và check lại một dự án mẫu để chắc mọi skill vẫn chạy.
"""
import json
import shutil
import subprocess
import sys

from common import RUNTIME

REPO = 'https://github.com/remotion-dev/remotion'
DOCS = RUNTIME / 'docs'


def current() -> str:
    return json.loads((RUNTIME / 'package.json').read_text())['dependencies']['remotion']


def bump(version: str):
    pkg_f = RUNTIME / 'package.json'
    pkg = json.loads(pkg_f.read_text())
    n = 0
    for sec in ('dependencies', 'devDependencies'):
        for name in pkg.get(sec, {}):
            if name == 'remotion' or name.startswith('@remotion/'):
                pkg[sec][name] = version
                n += 1
    pkg_f.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
    print(f'{n} gói → {version}')
    if subprocess.run(['npm', 'install'], cwd=RUNTIME).returncode:
        sys.exit('npm install lỗi (package.json đã đổi; sửa rồi chạy lại)')


def fetch_docs(version: str):
    stamp = DOCS / '.version'
    if stamp.exists() and stamp.read_text().strip() == version:
        print(f'remotion/docs đã đúng bản {version}')
        return
    tmp = RUNTIME / '.docs-tmp'
    shutil.rmtree(tmp, ignore_errors=True)
    git = lambda *a, **kw: subprocess.run(['git', *a], check=True, **kw)  # noqa: E731
    print(f'tải tài liệu Remotion v{version} …')
    git('-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', f'v{version}', '--filter=blob:none', '--sparse', REPO, str(tmp))
    git('sparse-checkout', 'set', '--no-cone', '/packages/skills/skills/', '/packages/docs/docs/**/*.md', '/packages/docs/docs/**/*.mdx', cwd=tmp)
    shutil.rmtree(DOCS, ignore_errors=True)
    DOCS.mkdir()
    for src, dst in (('packages/skills/skills', 'skills'), ('packages/docs/docs', 'docs')):
        if (tmp / src).exists():
            shutil.move(str(tmp / src), DOCS / dst)
    shutil.rmtree(tmp, ignore_errors=True)
    stamp.write_text(version + '\n')
    n = sum(1 for _ in (DOCS / 'docs').rglob('*.md*')) if (DOCS / 'docs').exists() else 0
    print(f'remotion/docs: {n} trang tài liệu, skills: {", ".join(p.name for p in (DOCS / "skills").iterdir()) if (DOCS / "skills").exists() else "—"}')


def main():
    argv = sys.argv[1:]
    if argv:
        v = argv[0]
        if v == 'latest':
            v = subprocess.run(['npm', 'view', 'remotion', 'version'], capture_output=True, text=True, check=True).stdout.strip()
        if v != current():
            bump(v)
    fetch_docs(current())


if __name__ == '__main__':
    main()
