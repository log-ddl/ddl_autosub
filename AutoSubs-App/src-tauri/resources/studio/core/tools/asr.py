#!/usr/bin/env python3
"""Phiên âm voice của một project, lấy timing thật tới từng từ.

    .venv/bin/python core/tools/asr.py <id> [--voice đường_dẫn.mp3]
    .venv/bin/python core/tools/asr.py <id> --chapters    cắt transcript.json theo plan/chapters/CNN.json
                                                          → plan/chapters/CNN.voice.md, có mốc mọi từ
    .venv/bin/python core/tools/asr.py <id> --map-only    viết lại voice_map.md từ transcript.json

Ghi:
  projects/<id>/plan/transcript.json   {"lang", "duration", "segments":[{start,end,text,words:[{w,s,e}]}]}
  projects/<id>/plan/voice_map.md      bản đọc cho người: câu có mốc, khoảng ngắt dài, từ có số/tên riêng
Model: deepdml/faster-whisper-large-v3-turbo-ct2 (đã có trong ~/.cache/huggingface).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAUSE = 0.45  # giây; khoảng ngắt dài hơn mức này được đánh dấu


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True).stdout.strip()
    return float(out) if out else 0.0


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(1)
    pid = a[0]
    pdir = ROOT / 'projects' / pid
    voice = Path(a[a.index('--voice') + 1]) if '--voice' in a else pdir / 'assets/voice/voice.mp3'
    if not voice.exists():
        sys.exit(f'không thấy voice: {voice}')
    from faster_whisper import WhisperModel
    m = WhisperModel('deepdml/faster-whisper-large-v3-turbo-ct2', device='cpu', compute_type='int8')
    segs, info = m.transcribe(str(voice), word_timestamps=True, vad_filter=True, language=None)
    out = []
    for s in segs:
        words = [{'w': w.word.strip(), 's': round(w.start, 2), 'e': round(w.end, 2)} for w in (s.words or [])]
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip(), 'words': words})
        print(f'{s.start:7.2f}–{s.end:7.2f}  {s.text.strip()}', flush=True)
    dur = probe(voice)
    (pdir / 'plan').mkdir(parents=True, exist_ok=True)
    json.dump({'lang': info.language, 'duration': round(dur, 3), 'segments': out},
              open(pdir / 'plan/transcript.json', 'w'), ensure_ascii=False, indent=1)
    write_map(pdir, out, dur)
    print(f'→ {pdir / "plan/transcript.json"}\n→ {pdir / "plan/voice_map.md"}  (voice {dur:.3f}s)')


def write_map(pdir, segs, dur):
    num = re.compile(r'\d')
    L = [f'# Bản đồ voice ({dur:.2f} s)', '',
         'Mỗi dòng: mốc câu, rồi nội dung. `‖ 0.8s` = khoảng ngắt dài (chỗ nghỉ tự nhiên). '
         '**Đậm** = từ có số hoặc viết hoa giữa câu (ứng viên callout và điểm khớp hình), kèm mốc từ.', '']
    prev = 0.0
    for s in segs:
        gap = s['start'] - prev
        if gap >= PAUSE:
            L.append(f'‖ {gap:.1f}s')
        keys = []
        for i, w in enumerate(s['words']):
            t = w['w'].strip(',.!?;:')
            if t and (num.search(t) or (i > 0 and t[:1].isupper())):
                keys.append(f"**{t}**@{w['s']:.2f}")
        line = f"`{s['start']:7.2f}–{s['end']:7.2f}` {s['text']}"
        if keys:
            line += '  ' + ' '.join(keys)
        L.append(line)
        prev = s['end']
    if dur - prev >= PAUSE:
        L.append(f'‖ {dur - prev:.1f}s (đuôi)')
    (pdir / 'plan/voice_map.md').write_text('\n'.join(L) + '\n')


def write_chapter_maps(pdir):
    """plan/chapters/CNN.voice.md — câu của đúng chương đó, kèm mốc MỌI từ (để đặt CUE khớp từng từ)."""
    d = json.load(open(pdir / 'plan/transcript.json'))
    chs = sorted((pdir / 'plan/chapters').glob('C[0-9][0-9].json'))
    if not chs:
        sys.exit('chưa có plan/chapters/CNN.json (ít nhất id/from/to)')
    for f in chs:
        c = json.load(open(f))
        a, b = c['from'], c['to']
        L = [f"# Voice chương {f.stem}: {c.get('title', '')} ({a:.2f}–{b:.2f} s)", '',
             'Mốc là giây toàn phim. Mỗi câu: dòng mốc + nội dung, dòng dưới là từng từ `từ@giây`. `‖` = khoảng ngắt dài.', '']
        prev = None
        for s in d['segments']:
            mid = (s['start'] + s['end']) / 2
            if not (a <= mid < b):
                continue
            if prev is not None and s['start'] - prev >= PAUSE:
                L.append(f"‖ {s['start'] - prev:.1f}s")
            L.append(f"`{s['start']:7.2f}–{s['end']:7.2f}` {s['text']}")
            if s.get('words'):
                L.append('  ' + ' '.join(f"{w['w']}@{w['s']:.2f}" for w in s['words']))
            prev = s['end']
        out = f.with_name(f'{f.stem}.voice.md')
        out.write_text('\n'.join(L) + '\n')
        print(f'→ {out}')


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--chapters':
        write_chapter_maps(ROOT / 'projects' / sys.argv[1])
    elif len(sys.argv) > 2 and sys.argv[2] == '--map-only':
        p = ROOT / 'projects' / sys.argv[1]
        d = json.load(open(p / 'plan/transcript.json'))
        segs = [dict(s, words=s.get('words', [])) for s in d['segments']]
        write_map(p, segs, d.get('duration') or probe(p / 'assets/voice/voice.mp3'))
        print(f'→ {p / "plan/voice_map.md"}')
    else:
        main()
