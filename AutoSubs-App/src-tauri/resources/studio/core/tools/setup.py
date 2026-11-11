#!/usr/bin/env python3
"""Cài đặt / nối dây một lần (chạy lại thoải mái sau khi thêm skill hay kéo code mới).

    python3 core/tools/setup.py

- remotion/: cài node_modules nếu chưa có; link node_modules ở gốc repo (để code trong projects/, skills/ thấy thư viện).
- tsconfig.json ở gốc cho editor (alias @core, @skill/<tên>).
- Mỗi skills/<tên>/ được link vào .claude/skills/ (Claude Code) và .agents/skills/ (Codex, agy): chỉ sửa skill ở skills/.
"""
import os
import subprocess
import sys
from pathlib import Path

from common import ROOT, RUNTIME, SKILLS, write_tsconfig


def link(target: Path, at: Path):
    at.parent.mkdir(parents=True, exist_ok=True)
    rel = os.path.relpath(target, at.parent)
    if at.is_symlink():
        if os.readlink(at) == rel:
            return
        at.unlink()
    elif at.exists():
        print(f'  bỏ qua {at.relative_to(ROOT)}: đã có thư mục thật (không phải link)')
        return
    os.symlink(rel, at)
    print(f'  {at.relative_to(ROOT)} → {rel}')


def main():
    if not (RUNTIME / 'node_modules').is_dir():
        print('cài remotion/node_modules …')
        if subprocess.run(['npm', 'ci'], cwd=RUNTIME).returncode:
            sys.exit('npm ci lỗi')
    link(RUNTIME / 'node_modules', ROOT / 'node_modules')
    write_tsconfig(ROOT / 'tsconfig.json', ['core/kit', 'skills/*/lib', 'projects/*/src', 'projects/*/.build/*.ts*'])

    skills = sorted(d for d in SKILLS.iterdir() if (d / 'SKILL.md').is_file())
    for home in (ROOT / '.claude/skills', ROOT / '.agents/skills'):
        for d in skills:
            link(d, home / d.name)
        for old in home.iterdir() if home.is_dir() else []:
            if old.is_symlink() and not old.exists():
                old.unlink()
                print(f'  xoá link hỏng {old.relative_to(ROOT)}')
    print(f"skill: {', '.join(d.name for d in skills)}")
    if not (ROOT / '.venv/bin/python').exists():
        print('chưa có .venv: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt')
    if not (RUNTIME / 'docs/.version').exists():
        print('chưa có tài liệu Remotion: python3 core/tools/upgrade.py')


if __name__ == '__main__':
    main()
