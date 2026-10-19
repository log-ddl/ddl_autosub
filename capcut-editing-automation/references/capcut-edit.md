# The CapCut edit

## Contents
1. Handing over to the viewer: create the project, import, quit
2. Finding and copying the project
3. Finding sounds in their library
4. The edit plan (full format)
5. Editing craft: what makes the edit good
6. Build, check, fix
7. Installing the timeline (routes A, B, C)
8. After installing
9. How CapCut stores a project (background)

## 1. Handing over to the viewer

First put the media on their computer: every shot JPG plus the voiceover (copied in as `<Video Name> voiceover.wav`, or the `.m4a`), and nothing else, in one folder named after the video (for example `~/Movies/CapCut Automation/<Video Name>/` on Mac, `C:\Users\<name>\Videos\CapCut Automation\<Video Name>\` on Windows).
- Route A: write the files straight into that folder.
- Route B: `device_commit_files`, one entry per file (`stagedPath` = the file under `/mnt/user-data/outputs/<slug>/media/`, `devicePath` = the real folder path + file name). Max 50 files and 100 MB per call, so send in batches.
- Route C: `python3 scripts/package_offline.py media --dir "<media folder>" --project-name "<Video Name>" --out "work/<slug>/out/<Video Name> media.zip"`, send it, and add to the message below: "First unzip it somewhere it can stay (for example Movies or Videos) and don't move it afterwards."

Music and sound effects stay in their own library (routes A and B), so they don't need importing.

Then send this (adapt the folder path and name; keep the steps):

> Your shots and voiceover are in **<folder>**. Four quick steps in CapCut and I'll build the whole edit:
> 1. Open CapCut and start a **New project**.
> 2. Click **Import**, open that folder, select **all** the files and import them. Don't drag anything onto the timeline.
> 3. Rename the project (click its name at the top) to **<Video Name>**.
> 4. **Quit CapCut completely.** Mac: Cmd+Q (or CapCut menu > Quit). Windows: close it and check it isn't still running in the system tray.
>
> Reply "done" once CapCut is closed. If CapCut is open while I write the timeline, it overwrites my work when it closes.

## 2. Finding and copying the project

Projects are folders inside the CapCut projects folder (Mac `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`, Windows `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`). The folder name often isn't the project name (it can be a date like `1007 (1)`), so find it by the name stored inside:

```bash
cd "<projects folder as seen by your shell>"
for d in */; do grep -Eq '"draft_name": ?"<Video Name>"' "$d/draft_meta_info.json" 2>/dev/null && echo "$d"; done
```
If two folders match, take the most recently modified one (`ls -td`). Then inside it:
- The timeline file is `draft_info.json` (Mac) or `draft_content.json` (Windows, some versions). Check its first character is `{` (`head -c 1`). Anything else means this CapCut build encrypts projects: stop and see troubleshooting.md.
- Note `Timelines/project.json` (its `main_timeline_id` names the subfolder that holds the second set of copies).

Copy the timeline file, `draft_meta_info.json` and `Timelines/project.json` into `work/<slug>/capcut_project/` (keep `Timelines/project.json` in a `Timelines` subfolder). In route B use `device_stage_files` and keep the returned `mtimeMs` of the timeline file and meta file: you need them when writing back. In route A note `md5sum` of the timeline file for `--expect-md5`.

`draft_meta_info.json` also lists everything imported into the project's media bin (`draft_materials[].value[].file_Path`). The builder uses it to find any file whose real path you didn't map.

## 3. Finding sounds in their library

**Index it.** Route A (folder mounted where you run):
```bash
python3 scripts/scan_library.py index --root "<mounted sounds folder>" --device-root "<real path of that folder>" --out work/<slug>/library.json
```
Route B: list it on the computer into a hidden file next to (not inside) the video's media folder, stage that one file, then index it:
```bash
cd "$HOME/mnt/<sounds folder>" && find -L . -type f \( -iname '*.wav' -o -iname '*.mp3' -o -iname '*.m4a' -o -iname '*.aif*' -o -iname '*.flac' -o -iname '*.ogg' \) -printf '%s\t%P\n' > "$HOME/mnt/<path to the CapCut Automation folder>/.cca_sound_list.txt"; wc -l < "$HOME/mnt/<path to the CapCut Automation folder>/.cca_sound_list.txt"
python3 scripts/scan_library.py index --listing <staged .cca_sound_list.txt> --device-root "<real path of the sounds folder>" --out work/<slug>/library.json
```
(Keeping it out of the media folder matters: the viewer imports everything in that folder.)

**Search it.**
```bash
python3 scripts/scan_library.py cues --lib work/<slug>/library.json          # 3 candidates for every type of moment
python3 scripts/scan_library.py find --lib work/<slug>/library.json --q "record scratch, scratch" --kind sfx
python3 scripts/scan_library.py music --lib work/<slug>/library.json --q "quirky, comedy, pizzicato, marimba"
```
Pick by name and folder (you can't listen). Prefer instrumental music (skip names with "vocal", "vox", "lyrics") whose mood fits: quirky/pizzicato/marimba for funny history, dark ambient or tension for mysteries, warm corporate/acoustic for explainers, lo-fi for calm topics. Offer the viewer the top three music picks by name if they're around; otherwise choose and say which.

**Copy only what you'll use** into the workspace for measuring (route B: `device_stage_files` with the real paths; they land in `/mnt/user-data/uploads/<sounds folder name>/<relative path>`; route A: read them in place). Then measure:
```bash
python3 scripts/analyze_audio.py --cache work/<slug>/audio_cache.json "<sfx file>" ...
python3 scripts/analyze_audio.py --music --cache work/<slug>/audio_cache.json "<music file>"
```
Route C: ask the viewer to upload one to three music tracks and a batch of sound effects (a zip is fine); copy the ones you use into the media folder before zipping it, so they get imported with the shots.

## 4. The edit plan

Create it from the timed shots, then add music, sound effects and captions:
```bash
python3 scripts/make_plan.py --shots work/<slug>/timing/shots_timed.json --manifest work/<slug>/shots/manifest.json \
  --vo "<media folder>/<Video Name> voiceover.wav" --words work/<slug>/timing/words.json --out work/<slug>/edit_plan.json \
  --map "<media folder as seen here>/" "<real media folder path>/" \
  --map "<sounds folder as seen here>/" "<real sounds folder path>/"
```
`path_map` turns every local path into the path CapCut will use on their computer (Windows paths are fine, either slash). "As seen here" is the path your scripts read: in route A the mounted folder, in route B the staging copy (`/mnt/user-data/outputs/<slug>/media/` for the media, `/mnt/user-data/uploads/<sounds folder name>/` for staged sounds). In route C leave the media unmapped: the builder finds each file in the project's media bin by file name.

**Times** can be seconds or expressions: `w12` (start of script word 12, from `words.txt`), `e12` (end of word 12), `c5` (cut where shot 5 starts), `end` (end of the timeline), each with an optional offset like `w12+0.05` or `c5-0.1`. Use expressions: they keep cues glued to the words if the timing is rebuilt.

```json
{
 "fps": 30, "end": 183.0,
 "words": ".../words.json", "shots_file": ".../shots_timed.json",
 "path_map": [["<media folder as seen here>/", "/Users/sam/Movies/CapCut Automation/Emu War/"],
              ["<sounds folder as seen here>/", "/Users/sam/Documents/Sound Library/"]],
 "vo": {"file": ".../Emu War voiceover.wav"},
 "zoom": {"per_sec": 0.011, "min": 0.015, "max": 0.045},
 "shots": [{"n": 1, "file": ".../01_0m00.0s.jpg", "analysis": ".../shots/01.png", "zoom": "in"}],
 "music": [{"file": ".../Quirky Marimba.wav", "start": 0, "end": "end",
            "align": {"music_t": 180.3, "at": "w432"},
            "fin": 0.3, "fout": 1.4, "target_lufs": -30,
            "dropouts": [["w215+0.03", "c23"]], "lift": {"at": "w432-0.25", "db": 4}}],
 "sfx": [{"t": "w13", "file": ".../Power Hum.wav", "level": "soft", "note": "20,000 emus"},
         {"t": "w110", "file": ".../Thud.wav", "align": "peak", "level": "hit", "note": "APPROVED stamp"},
         {"t": "c5", "file": ".../Farm Ambience.wav", "src": 3.4, "dur": 5.0, "level": "low", "fin": 0.4, "fout": 0.8}],
 "text": [{"text": "1932", "start": 0, "end": "w13-0.05", "style": "num"},
          {"text": "MAJOR MEREDITH", "sub": "ROYAL AUSTRALIAN ARTILLERY", "start": "w113", "end": "c12", "style": "lower"},
          {"text": "APPROVED", "start": "w110", "end": "c11", "style": "stamp", "pos": [780, 900]}]
}
```
Field notes:
- `shots[].zoom`: `"in"`, `"out"`, `"none"` or a number (+0.03 = zoom in 3%). Default alternates in/out; the amount grows with shot length between `min` and `max`.
- `sfx[]`: `align` is `"onset"` (default: the sound's start lands on `t`), `"peak"` (its loudest moment lands on `t`; use for impacts) or `"start"` (file start at `t`). `src`/`dur` take a slice of a long file. `level`: `hit`, `accent`, `soft`, `bed`, `low` (or a number of dB relative to the voice). `fin`/`fout` are fades in seconds. Without `src`/`dur`, a `peak` cue starts 1 s before the file's peak, and one-shot levels (`hit`, `accent`, `soft`) stop 1.6 s after the cue with a fade, so long ring-outs don't play under the next lines; the build warns when a clip still starts long before its cue or runs long. For anything longer (ambience, risers, drum rolls) give `src` and `dur` and use `bed` or `low`.
- `music[]`: one item per track section; overlapping items go on separate tracks (use for crossfades). `align.music_t` is a moment in the music file (from `analyze_audio.py --music`, `hits_last_30s`) that should land on `align.at`. `target_lufs` is the music's level under the voice (-30 default; -28 livelier, -32 calmer). `dropouts` cut the music dead for comic beats and bring it back at the second time. `lift` raises it for the ending.
- `text[]`: optional `"ok_busy": true` silences the placement warning once you've checked the still. `style` one of `num`, `big`, `label`, `title`, `quote`, `lower` (with `sub`), `stamp`, `year`, `cta`. `pos` is `"auto"` (default: finds the clearest spot along the style's rows and shrinks if needed), an anchor (`"top"`, `"bottom-left"`, ...) or `[x, y]` pixels on the 1920x1080 frame. Optional `size`, `color` (`yellow`, `white`, `red`, `green`, `blue`, `orange`, or `#RRGGBB`), `rot`, `box` `[x0, y0, x1, y1]`. Use `\n` for line breaks.

## 5. Editing craft

The goal is an edit that feels hand-made: the picture changes exactly with the voice, something small moves all the time, sounds underline the story's beats, and the music sits underneath without fighting the voice.

**Cuts.** Already decided by the timing: each cut sits in the pause before its line, a frame or two early. Don't move them by hand. If `align_vo.py` noted a long pause inside a sentence, that shot holds on a silent beat: fill it on purpose (a drum roll, ticking clock, a reaction caption) rather than leaving dead air.

**Zooms.** Every shot gets a slow push in or pull out (alternating), 1.5% to 4.5%. It should be barely noticeable, just enough life. Use `"none"` for title cards, maps and diagrams if they look better still. Don't go above about 6%.

**Sound effects** (the reference video used about one every 2.5 seconds):
- Scene changes and time jumps: a whoosh on the cut (`t: "cN-0.08"`, accent or soft).
- Captions with numbers or names: a pop, blip or click as the caption appears (same `t` as the caption start, soft or accent).
- Stamps, slams, punchlines: an impact aligned by `peak` to the word, level `hit`.
- Comedy: record scratch (and a music dropout) before a deadpan line; boing/elastic for bumpy or silly motion; a sad trombone or buzzer for failure; ding or level-up for success; cash register for money.
- Tension and reveals: a riser ending on the reveal (`align: "peak"`, `src` chosen so the peak lands on the word), then an impact.
- Ambience beds under establishing shots (wind, farm, city, crowd): a slice of a long file with `src`/`dur`, level `low` or `bed`, fades of 0.3-0.8 s.
- Repeated items (three rabbits, three knocks): the same pop several times 0.15-0.3 s apart, the later ones quieter.
- Leave some moments bare: contrast makes the hits land. Never stack two `hit`s within a quarter second.

**Music.**
- 3 minutes or less: one track. Longer: change track at a big story turn, with a short crossfade (overlapping items, `fout`/`fin` of 1-2 s).
- Land the ending: find a strong hit near the end of the track (`hits_last_30s`) and `align` it to the last big line, then `lift` by 3-4 dB from just before that line. The final chord ringing out under a short outro or call to action (a few seconds) sounds natural; if more than about 4 seconds of voice follow the hit, align the hit later (for example to the last word) so the track doesn't end early. `sound_end` from `analyze_audio.py --music` tells you when the track has faded out, and the build warns if that happens well before the end.
- Dropouts: 1-3 per video at comic beats ("Bad idea.", "the gun jammed"). The music stops dead and comes back on the next cut.
- If a track is shorter than the section it covers, the build warns you: add a second item.

**Captions.**
- What: numbers and stats, names with roles (`lower`), places and dates (`label`), the title (`title`), one-word punchlines (`stamp`), short quotes (`quote`), the end call to action (`cta`). Up to about 4 words a line, 1-3 lines, capitals.
- When: start on the word (`wN`), end at the next cut or just before the next caption; at least about a second on screen. Roughly one caption every 2-3 shots.
- Where: leave `pos` on auto. Override with `[x, y]` when the caption belongs on an object (a stamp on a document) or when the stills show a problem.
- Colours: yellow for numbers, white for labels, red for stamps (the defaults) keep the video consistent.

## 6. Build, check, fix

```bash
python3 scripts/build_capcut.py --plan work/<slug>/edit_plan.json --project work/<slug>/capcut_project --out work/<slug>/build [--capcut-font <CapCut en.ttf if you have it>]
python3 scripts/preview.py --build work/<slug>/build --out work/<slug>/preview/check --stills-only
```
In route B use an `--out` under `/mnt/user-data/outputs/<slug>/` so the result can be committed.

1. Read `build/report.md`: track counts, every caption (size, position, busy score) and every sound effect (cue time, where the clip starts, its length, volume). Act on every warning; each says what to change. A caption warning means the automatic placement found no clear spot or the text got small: look at that still, then set `pos`/`size`, shorten the text, or mark it `"ok_busy": true` if it is fine (plain walls and signs can score as busy).
2. Look at every `captions_*.jpg` contact sheet. A caption must not cover a face or an important object and must be readable. Fix with `pos`, `size` or shorter text, and rebuild.
3. When the stills are clean, render the full preview (about 1.5x real time):
   `python3 scripts/preview.py --build work/<slug>/build --out work/<slug>/preview/<Video Name> preview`
   It prints the mix peak, when it happens and what is playing then, plus the loudness: keep the peak below -0.5 dBFS (loudness lands around -16 LUFS). If it peaks higher, lower whatever is playing at that moment (an effect's `level`, or the music's `target_lufs`).
4. Send the preview MP4 to the viewer before or right after installing, so they see the edit even before opening CapCut.

The builder refuses to write a timeline with overlapping clips, gaps between shots, keyframes outside their clip or captions that can't fit. Its error message says which item is wrong.

## 7. Installing the timeline

Ask the viewer to confirm CapCut is still closed before writing.

**Route A (you can write the project folder directly):**
```bash
python3 scripts/install_to_project.py --build work/<slug>/build --project "<mounted project folder>" --expect-md5 <md5 noted when you copied it>
```
It backs up every file it touches to `_backup_before_cca_<time>/` inside the project, writes the timeline to all its copies, updates the duration and verifies checksums.

**Route B (device tools):**
1. Back up: copy the staged originals to `/mnt/user-data/outputs/<slug>/backup/` and commit them to `<project>/_backup_before_cca_<time>/` with the same relative paths.
2. With `device_list_dir`, check which of the paths in `build/install_targets.txt` exist in the project.
3. `device_commit_files`: the built timeline file to every existing target, and the built `draft_meta_info.json` to the project. Pass `expectedMtimeMs` (from staging) for the root timeline file and the meta file, so nothing is overwritten if CapCut saved in the meantime. If a write is refused for that reason, stop, ask them to quit CapCut, stage again and rebuild.
4. Verify with `device_bash`: `md5sum` of every written copy must equal `md5` in `build/build_report.json`.
5. Check every media path exists: `while read -r p; do [ -f "<mount for that path>" ] || echo "MISSING $p"; done` over `build/device_paths.txt` (map the real paths to their `$HOME/mnt/...` mounts).

**Route C (no access):**
1. Ask them to upload two files from the project folder: `draft_meta_info.json` and `draft_info.json` (or `draft_content.json`). To find the folder: Mac, Finder > Go > Go to Folder, paste `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`; Windows, paste `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft` into the File Explorer address bar. The project is the most recently modified folder.
2. Put both in `work/<slug>/capcut_project/` and build without media `path_map` entries (the media bin supplies the real paths; music and effects must have been imported too).
3. `python3 scripts/package_offline.py install --build work/<slug>/build --project-name "<Video Name>" --out "work/<slug>/out/<Video Name> install.zip"` and send it with these steps: quit CapCut; Mac: unzip, right-click `install_mac.command` > Open (or in Terminal type `bash ` and drag the file in); Windows: unzip, double-click `install_windows.bat` (SmartScreen: More info > Run anyway); then open the project in CapCut.

## 8. After installing

Tell the viewer to open CapCut and click the project. They'll see the shots on the main track with their zoom keyframes, the voiceover, the music with its volume keyframes, the sound effects on their own tracks and the captions above. CapCut re-saves the project when they open it (it may snap a few values to whole frames, which is normal).

Mention that a backup of the empty project is inside the project folder, and offer next steps: thumbnail ideas, title and description with chapters (scene start times from `scenes.json`), or changes to the edit (edit the plan, rebuild, reinstall: CapCut must be closed again).

## 9. How CapCut stores a project (background)

- A project folder holds the timeline in up to six identical copies: `draft_info.json` (or `draft_content.json`), its `.bak`, `template-2.tmp`, and the same three in `Timelines/<timeline id>/`. CapCut may load any of them, so all are written. `template.tmp` is an older, different structure: leave it alone.
- `draft_meta_info.json` holds the name, the media bin and `tm_duration` (shown on the project card).
- Times are microseconds. Keyframe values are absolute (a scale keyframe replaces the clip's scale), and keyframe times are offsets from the clip start. CapCut snaps clip starts, including where inside a source file a clip starts, to whole frames, so the builder does too.
- All objects are cloned from templates CapCut itself saved (`assets/capcut_templates.json`, CapCut 9.5); the top-level settings and version numbers come from the viewer's own empty project, so their CapCut version opens it as its own. A timeline built this way (the reference video: 46 shots, 74 sound effects, 41 captions) was opened, edited and re-saved by CapCut with every clip, keyframe and caption intact.
