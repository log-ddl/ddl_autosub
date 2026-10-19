---
name: capcut-editing-automation
description: Makes a faceless YouTube video end to end, from script, Higgsfield voiceover and art to a fully edited CapCut project (synced cuts, zooms, SFX, music, captions). Use for stickman or explainer videos.
---

# CapCut Editing Automation Skill

Turn a topic into a finished, edited CapCut project: a researched script, a Higgsfield voiceover, a consistent cast of characters, one image per line, and a CapCut timeline where every shot is cut on the voice, gently zooms, sound effects hit the beats, music sits under the voice, and captions fit cleanly in frame. The viewer only creates an empty CapCut project, imports the media and quits CapCut; Claude writes the whole timeline into it.

Needs: code execution, the Higgsfield connector (with credits) and the CapCut desktop app on Mac or Windows. It works best when Claude can reach the viewer's folders; without that it delivers download-and-install zips.

This was built from a real production (a 3-minute stickman history video: 46 shots, 74 sound effects, 41 captions) that CapCut opened, edited and re-saved intact. The scripts in `scripts/` encode what that took; use them rather than rewriting their logic.

## How the run goes

| Step | What happens | Viewer checkpoint |
| --- | --- | --- |
| 0 | Setup check | told what's missing before anything is spent |
| 1 | Questions: length, style, topic, Mac/Windows, sound library | answers |
| 2 | Researched script | approves the script |
| 3 | Voice choice, voiceover, word timing | picks a voice; gets the audio |
| 4 | Shot list timed to the voiceover | gets the table |
| 5 | Character sheet (2 versions) | approves one (required) |
| 6 | All shots, checked and retaken | gets contact sheets |
| 7 | Music and sound effects from their own library | can veto the music |
| 8 | Media delivered; viewer creates the CapCut project, imports, quits | replies "done" |
| 9 | Timeline built, checked, previewed | gets the preview |
| 10 | Timeline installed into the project | opens CapCut |
| 11 | Optional extras: thumbnails, title/description/chapters | |

Make a task list with these steps at the start; the viewer may step away and it shows them where things stand. Keep each video's files in `work/<video-slug>/`. Commands below are run from this skill's folder (use full paths otherwise); the scripts import each other, so keep them together.

If the viewer isn't answering, keep going with sensible defaults (stickmen, 3 minutes, the first voice you'd recommend, your best music pick) and say which you chose. Two things always wait for them: approving the character sheet, and confirming CapCut is closed before you write the project. Never spend credits beyond the estimate you showed without asking.

## Step 0: Setup check

Read `references/setup.md` now. In short:
1. `python3 scripts/check_env.py --whisper` (installs what's missing; whisper is optional).
2. Higgsfield connected? Call `balance`. If the tools aren't there, ask them to connect Higgsfield and stop until they do.
3. Work out how you can reach their computer: (A) a shell with their folders mounted, (B) device tools from a cloud session, or (C) none, using zips. This decides how media and the timeline get delivered later.
4. Show the credit estimate for the length they want (table in setup.md; confirm prices with `get_cost`).

## Step 1: Questions

Ask these together (AskUserQuestion when available, otherwise in one short message). Skip anything they already told you.
1. **How long should the video be?** 1, 3, 5, or 8-10 minutes, or a custom length. This sets the word count (about 150 words a minute) and the cost.
2. **What should the characters look like?** Stickmen (default), whiteboard doodle, flat vector cartoon, paper cut-out, comic book, 3D clay, retro cartoon, or their own (describe it or upload a picture). Menu and prompt wording: `references/visuals.md` section 1.
3. **Topic?** Use theirs, or offer three topics with a one-line hook each.
4. **Mac or Windows, and where is your music and sound effects folder?** (In route B you can read the platform from `get_device_info`.)

Then ask for folder access in one go (route A/B; exact folders in setup.md section 3): CapCut's projects folder, a place for this video's media, and their sound library.

## Step 2: Script

Follow `references/script-and-voice.md` section 1: research with sources, about 150 words per minute, a hook in the first 10-15 seconds that says the topic's search phrase out loud, short visual sentences, 6-12 scenes each under 1,900 characters. Present it with word count, estimated length and sources, and wait for approval. Save `script.json`. Write the shot list (`references/visuals.md` section 2) right after approval; it only needs the words.

## Step 3: Voiceover and timing

Offer three voices from `list_voices` with preview links. Generate one `seed_audio` request per scene in a batch, download, then:
```bash
python3 scripts/stitch_vo.py --script work/<slug>/script.json --clips <scene files in order> --out work/<slug>/vo/voiceover.wav --target-seconds <seconds>
python3 scripts/align_vo.py --scenes work/<slug>/vo/scenes.json --out work/<slug>/timing/words.json --names "<proper nouns>"
```
`words.txt` (next to words.json) lists every script word with its index and time; captions and sound effects refer to words as `wN`. Send the voiceover to the viewer. Details and pitfalls (2,048-character limit, speech_rate, mispronunciations): `references/script-and-voice.md`.

## Step 4: Shot timing

```bash
python3 scripts/plan_shots.py --shots work/<slug>/shotlist.json --words work/<slug>/timing/words.json --scenes work/<slug>/vo/scenes.json --out work/<slug>/timing/shots_timed.json
```
Each cut lands in the pause before its line, a frame or two early. Share `shots_table.md`. Fix any notes about very short or long shots in the shot list and re-run.

## Step 5: Character sheet (approval required)

Generate two versions of the sheet in the chosen style (`references/visuals.md` section 3). Show both, get an approval, then split it into one reference image per character and upload them (section 4). Attach only the characters in each shot: attaching the whole sheet makes the model paste the full cast into every scene.

## Step 6: Shots

Confirm the image count and cost, then generate in batches of 12, download, normalise to 1920x1080, and check every contact sheet yourself; retake misses right away (`references/visuals.md` sections 5-6). Send the viewer the contact sheets when the set is complete.

## Step 7: Music and sound effects

Index their library and pick candidates (`references/capcut-edit.md` section 3). Choose one music track per 3-4 minutes and sound effects for the story's beats. Measure everything you chose with `analyze_audio.py`. In routes A and B their files stay where they are and the timeline points at them; in route C they upload the sounds and you add the chosen ones to the media folder.

## Step 8: Hand over to the viewer

Copy the voiceover into the media folder as `<Video Name> voiceover.wav` (or the `.m4a` if stitch made one), so the folder holds only the shots and the voiceover. Put that folder on their computer, then send the exact handover message in `references/capcut-edit.md` section 1: new project, import all the files, rename it to the video name, quit CapCut completely, reply "done". Then find the project by its name and copy its files for the build (section 2). If the timeline file isn't plain JSON, stop: see `references/troubleshooting.md`, "Encrypted project".

## Step 9: Build the edit

```bash
python3 scripts/make_plan.py --shots work/<slug>/timing/shots_timed.json --manifest work/<slug>/shots/manifest.json --vo "<media folder>/<Video Name> voiceover.wav" --words work/<slug>/timing/words.json --out work/<slug>/edit_plan.json --map "<media folder as seen here>/" "<its real path>/" --map "<sounds folder as seen here>/" "<its real path>/"
```
`--vo` is the copy inside the media folder (the file CapCut will play), not the one in `work/<slug>/vo/`.
Add music, sound effects and captions to `edit_plan.json` following `references/capcut-edit.md` sections 4-5. That section is the difference between an edit that feels hand-made and one that feels automatic, so read it fully. Then build and check:
```bash
python3 scripts/build_capcut.py --plan work/<slug>/edit_plan.json --project work/<slug>/capcut_project --out work/<slug>/build
python3 scripts/preview.py --build work/<slug>/build --out work/<slug>/preview/check --stills-only
```
Read `build/report.md` and act on each warning (each one says what to change; a caption warning means "look at that still", and if it looks right mark it `"ok_busy": true`). Look at every caption still, fix and rebuild until clean. Then render the full preview MP4 (`preview.py` without `--stills-only`). It prints the mix peak and what is playing at that moment; keep the peak below -0.5 dBFS. Send the preview to the viewer.

## Step 10: Install

Ask the viewer to confirm CapCut is still closed. Install with the route that applies (`references/capcut-edit.md` section 7): `install_to_project.py` (route A), device tools with backups and checksums (route B), or the double-click installer zip from `package_offline.py` (route C). Verify, then tell them to open CapCut and click the project. Mention the backup folder inside the project.

## Step 11: Extras (offer once)

Thumbnail concepts (generate with the same style string and characters), and an upload pack: three title options with the keyword up front, a description with the sources and chapters (scene start times from `scenes.json`), and tags. Respect the viewer's own channel style if they describe it.

## Rules that save a run

- Paths in the timeline are the viewer's real paths (`/Users/...`, `C:/Users/...`), never mount or workspace paths. `path_map` does the translation; check `build/device_paths.txt`.
- Never write a project while CapCut might be open; it overwrites the timeline when it quits. Always back up first (the install scripts do).
- Find projects by `draft_name` inside `draft_meta_info.json`, not by folder name.
- Don't hand-edit the timeline JSON or invent CapCut fields; change the plan and rebuild. The builder's checks (no gaps, no overlaps, keyframes inside clips, captions inside the safe area) are what keep CapCut from rejecting the file.
- Images never contain text. Captions are added in CapCut.
- If you change the script or a scene's audio after timing, re-run stitch, align, plan_shots, normalize and the build: every time downstream moves.

## Files

- `references/setup.md`: tools, computer access routes, folders on Mac/Windows, costs
- `references/script-and-voice.md`: script rules, script.json, voices, generation, stitching
- `references/visuals.md`: style menu, shot list, character sheet, references, shot prompts, QA
- `references/capcut-edit.md`: handover message, project files, sound search, edit plan format, editing craft, build/QA, install
- `references/troubleshooting.md`: fixes for the common failures
- `scripts/`: `check_env`, `stitch_vo`, `align_vo`, `plan_shots`, `prep_images`, `scan_library`, `analyze_audio`, `make_plan`, `build_capcut` (+ `textfit`, `common`), `preview`, `install_to_project`, `package_offline`
- `assets/`: CapCut object templates, the caption font (Metropolis, public domain), sound cue keywords, Mac/Windows installers
