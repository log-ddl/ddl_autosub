"""Zips for viewers whose computer Claude can't reach (upload / download route).

media    python3 package_offline.py media --dir "<media folder>" --project-name "<Video Name>" --out "work/out/<Video Name> media.zip"
         everything CapCut needs (shots, voiceover, chosen music/sfx copies) in one folder + a README
install  python3 package_offline.py install --build work/build --project-name "My Video" --out work/out/<Video>_install.zip
         the finished timeline + double-click installers for Mac and Windows that find the project by name,
         back it up and write the timeline into it (media paths were taken from the viewer's own CapCut
         media bin, so the media must stay where it was when it was imported)
"""
import argparse
import os
import zipfile
import common as C

README_MEDIA = """{name} - media for CapCut
==========================================
1. Unzip this folder somewhere it can stay (for example Movies or Videos). Don't move or rename it later:
   the CapCut timeline points at these exact files.
2. Open CapCut > New project. Click Import and select ALL the files in this folder
   (do not drag anything onto the timeline).
3. Rename the project (top of the CapCut window) to: {name}
4. Quit CapCut completely (Mac: Cmd+Q. Windows: close it and check the system tray).
5. Back in Claude, upload the two files from the project folder that Claude asks for.
"""

README_INSTALL = """{name} - finished CapCut timeline
=========================================
1. Quit CapCut completely.
2. Mac: right-click install_mac.command > Open (first time macOS asks you to confirm).
   If macOS still blocks it: open Terminal, type  bash  and a space, drag install_mac.command into the window, press Enter.
   Windows: double-click install_windows.bat (if SmartScreen appears: More info > Run anyway).
3. Open CapCut and click the project "{name}".
The installer backs up the old project files into a _backup_before_cca_... folder inside the project first.
"""


def zadd(z, path, arc, exe=False, crlf=False):
    data = open(path, 'rb').read()
    if crlf:
        data = data.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    zi = zipfile.ZipInfo(arc)
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.external_attr = ((0o755 if exe else 0o644) | 0o100000) << 16
    z.writestr(zi, data)


def cmd_media(a):
    name = os.path.basename(os.path.normpath(a.dir))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    n = 0
    with zipfile.ZipFile(a.out, 'w') as z:
        for f in sorted(os.listdir(a.dir)):
            p = os.path.join(a.dir, f)
            if os.path.isfile(p):
                zadd(z, p, f'{name}/{f}')
                n += 1
        zi = zipfile.ZipInfo(f'{name}/README.txt')
        zi.external_attr = (0o644 | 0o100000) << 16
        z.writestr(zi, README_MEDIA.format(name=a.project_name or name).replace('\n', '\r\n'))
    print(f'{n} files -> {a.out}')


def cmd_install(a):
    rep = C.load_json(os.path.join(a.build, 'build_report.json'))
    D = C.load_json(os.path.join(a.build, rep['content_name']))
    name = a.project_name
    top = (a.folder or name.replace('/', '-') + ' - CapCut install').strip()
    inst = os.path.join(C.ASSETS, 'installers')
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    tmp = a.out + '.tmpdir'
    os.makedirs(tmp, exist_ok=True)
    subs = {'__PROJECT_NAME__': None, '__CONTENT_NAME__': rep['content_name'], '__DURATION__': str(D['duration'])}
    with zipfile.ZipFile(a.out, 'w') as z:
        for fn, exe, crlf, quote in (('install_mac.command', True, False, 'sh'), ('install_windows.ps1', False, True, 'ps'),
                                     ('install_windows.bat', False, True, None)):
            s = open(os.path.join(inst, fn), encoding='utf-8').read()
            nm = name.replace("'", "'\\''") if quote == 'sh' else name.replace("'", "''")
            for k, v in subs.items():
                s = s.replace(k, nm if v is None else v)
            p = os.path.join(tmp, fn)
            open(p, 'w', encoding='utf-8', newline='\n').write(s)
            zadd(z, p, f'{top}/{fn}', exe=exe, crlf=crlf)
        zadd(z, os.path.join(a.build, rep['content_name']), f"{top}/draft/{rep['content_name']}")
        zi = zipfile.ZipInfo(f'{top}/README.txt')
        zi.external_attr = (0o644 | 0o100000) << 16
        z.writestr(zi, README_INSTALL.format(name=name).replace('\n', '\r\n'))
    for f in os.listdir(tmp):
        os.remove(os.path.join(tmp, f))
    os.rmdir(tmp)
    print(f'installer for project "{name}" -> {a.out}')


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    m = sp.add_parser('media')
    m.add_argument('--dir', required=True)
    m.add_argument('--out', required=True)
    m.add_argument('--project-name')
    i = sp.add_parser('install')
    i.add_argument('--build', required=True)
    i.add_argument('--project-name', required=True, help="the project's name exactly as CapCut shows it")
    i.add_argument('--out', required=True)
    i.add_argument('--folder')
    a = ap.parse_args()
    {'media': cmd_media, 'install': cmd_install}[a.cmd](a)


if __name__ == '__main__':
    main()
