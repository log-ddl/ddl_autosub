"""Check (and quietly install) what the pipeline needs, then print a short status report.

usage: python3 check_env.py [--whisper] [--url https://...]
  --whisper   also try to install faster-whisper and load the small.en model (better word timing).
              Optional: align_vo.py falls back to pause-based timing when it is missing.
  --url       test that a generated-file URL (e.g. a Higgsfield result) can be downloaded from here.
"""
import argparse
import importlib
import json
import shutil
import subprocess
import sys
import urllib.request


def pip_install(*pkgs):
    for extra in ([], ['--break-system-packages']):
        r = subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', *pkgs, *extra], capture_output=True, text=True)
        if r.returncode == 0:
            return True
    return False


def need(mod, pkg=None):
    try:
        importlib.import_module(mod)
        return 'ok'
    except ImportError:
        if pip_install(pkg or mod):
            try:
                importlib.invalidate_caches()
                importlib.import_module(mod)
                return 'installed'
            except ImportError:
                pass
        return 'MISSING'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--whisper', action='store_true')
    ap.add_argument('--url')
    a = ap.parse_args()
    st = {'python': sys.version.split()[0]}
    st['numpy'] = need('numpy')
    st['pillow'] = need('PIL', 'pillow')
    st['scipy'] = need('scipy')
    ff = shutil.which('ffmpeg')
    if ff:
        st['ffmpeg'] = 'ok (system)'
    else:
        r = need('imageio_ffmpeg', 'imageio-ffmpeg')
        st['ffmpeg'] = 'ok (imageio-ffmpeg)' if r != 'MISSING' else 'MISSING'
    if a.whisper:
        r = need('faster_whisper', 'faster-whisper')
        if r != 'MISSING':
            try:
                from faster_whisper import WhisperModel
                WhisperModel('small.en', device='cpu', compute_type='int8')
                st['whisper'] = 'ok (small.en loaded)'
            except Exception as e:
                st['whisper'] = f'installed but model download failed ({type(e).__name__}); pause-based timing will be used'
        else:
            st['whisper'] = 'not available; pause-based timing will be used'
    if a.url:
        try:
            req = urllib.request.Request(a.url, method='GET', headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                r.read(1024)
            st['download_test'] = 'ok'
        except Exception as e:
            st['download_test'] = f'BLOCKED ({e}). Ask the viewer to allow this domain under Settings > Capabilities.'
    print(json.dumps(st, indent=1))
    if any(str(v).startswith('MISSING') for v in st.values()):
        sys.exit(1)


if __name__ == '__main__':
    main()
