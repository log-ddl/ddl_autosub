# Visuals: style, character sheet, shot list, shots

## Contents
1. Character style menu
2. Shot list (written before any image)
3. Character sheet
4. Per-character references (the fix for lineup copying)
5. Generating the shots
6. Quality check and retakes

Model for everything here: `gpt_image_2_5` with `quality: "high"`, `resolution: "2k"`, `aspect_ratio: "16:9"` (sheet: `"16:9"` too). Reference images go in `medias` with role `image_references`. Check the price once with `get_cost: true`.

## 1. Character style menu

Ask which look they want (offer these, plus "describe your own" or "upload a reference picture"). Stickmen is the default. Put the chosen style string at the start of every image prompt, word for word, so the whole video stays consistent. Never name a real studio, artist, show or brand in a style.

| Style | Style string for prompts |
| --- | --- |
| Stickmen (default) | flat 2D stickman illustration: round white heads with simple dot eyes and expressive eyebrows, thin black stick limbs, thick clean black outlines, simple solid-colour clothes and props, warm off-white background, muted earthy accents |
| Whiteboard doodle | hand-drawn black marker doodle on a clean white background, simple cartoon figures, loose confident lines, one accent colour used sparingly |
| Flat vector cartoon | flat vector illustration, simple geometric characters without outlines, bold harmonious colour palette, soft shadows, clean shapes, minimal background detail |
| Paper cut-out | layered paper cut-out collage, visible paper texture and soft drop shadows between layers, simple figures, craft-paper colours |
| Comic book | bold ink outlines, flat colours with light halftone shading, dynamic comic-panel compositions, expressive cartoon characters |
| 3D clay | soft 3D clay figures with rounded shapes and fingerprint texture, miniature diorama sets, warm studio lighting |
| Retro cartoon | 1950s-style cartoon illustration, rounded rubber-hose characters, limited retro palette, grainy print texture |

If they upload a reference picture: describe its style in the same kind of words (line, shapes, colour, background), upload it with `media_upload` and add it to every request as an extra `image_references` item.

## 2. Shot list

Write it as soon as the script is approved (it only needs the words) and time it once the voiceover exists. Save as `work/<slug>/shotlist.json`:
```json
[{"n": 1, "text": "In 1932, Australia sent soldiers with machine guns to fight a war against 20,000 emus.",
  "visual": "Wide shot: four soldiers in khaki march in a line carrying a machine gun on a tripod; the horizon behind them is packed with emus.",
  "chars": ["major", "soldier"], "onscreen": "1932 / 20,000 EMUS"}]
```
Rules:
- The `text` fields, joined in order, must be the script word for word (`plan_shots.py` checks this and tells you where it breaks).
- Usually one shot per sentence. Split a sentence at a comma when it would run past about 7 seconds; fold a fragment under about 1.2 seconds into its neighbour. Average 3-5 seconds a shot (about 15 shots a minute).
- Vary the framing like a real edit: wide establishing shots, medium action shots, close-up reactions, inserts of an object or a document, a map or simple diagram. Avoid two near-identical frames in a row.
- Show literally what the line says, with clear staging and expressive faces. Visual jokes and exaggeration help ("the emus scatter like bowling pins").
- `chars` lists only the recurring characters visible in that shot (names from the sheet). Crowds of unnamed people or animals don't need references.
- `onscreen` is the caption idea (numbers, names, dates, punchlines). Plan roughly one caption every 2-3 shots, not every shot. Where a caption is planned, ask the image for clear empty space there (see the prompt template).
- Images never contain text: the model garbles letters, and captions are added in CapCut.

Then time it:
```bash
python3 scripts/plan_shots.py --shots work/<slug>/shotlist.json --words work/<slug>/timing/words.json \
  --scenes work/<slug>/vo/scenes.json --out work/<slug>/timing/shots_timed.json
```
This writes `shots_table.md` (Start, End, Sec, Voiceover, Visual, On-screen). Share that table with the viewer (in the chat, or as a doc if they want to keep it) and fix any notes it prints about very short or very long shots.

## 3. Character sheet

Collect the recurring characters (at most about 6) from the shot list. Generate the sheet with `generate_image`, `count: 2`, so the viewer can choose between two versions:

```
<STYLE STRING>. Character reference sheet for an animated YouTube video. <N> characters standing side by side on a
plain background, each full body, facing the viewer, relaxed neutral pose, evenly spaced with clear empty space
between them, nothing overlapping. From left to right: 1) <name>: <age/build, clothing, colours, signature prop>,
2) ... Consistent proportions across all characters. No text, no labels, no names, no numbers.
```
Show both results and ask which one they approve (or what to change). This approval matters: every shot copies these designs. Don't generate shots until a sheet is approved.

## 4. Per-character references

Lesson from the reference video: when the whole sheet is attached to every shot, the model copies the entire lineup into scenes that should show one person. So cut the approved sheet into one image per character and attach only the characters that appear in each shot.

```bash
python3 scripts/prep_images.py split --image work/<slug>/sheet.png --n <N> --out work/<slug>/refs
```
Look at `split_overview.jpg` to confirm the boxes, then rename `char_1.png` etc. to the character names (or fix a bad box with `prep_images.py crop --box x0 y0 x1 y1`).

Upload the references to Higgsfield: `media_upload` with `files: [{filename: "major.png"}, ...]`, PUT each file to its `upload_url` with curl (`curl -sS -X PUT -T refs/major.png "<upload_url>"` plus any headers the tool returns), then `media_confirm` with `type: "image"` and all the ids. Keep the map name -> media id in `work/<slug>/refs/ids.json`.

If the upload is blocked by the network settings, generate each character on its own instead (one request each, the sheet's job id as the reference, prompt: "<STYLE STRING>. ONLY the <name> from the reference image, full body, centred, plain background, same design exactly. No text."). Use those job ids as the references.

## 5. Generating the shots

Prompt template (one per shot):
```
<STYLE STRING>. 16:9 frame. <visual description from the shot list>.
Characters: ONLY <names in this shot> (match the reference images exactly: same face, clothes, colours, proportions);
no other recurring characters. <If a caption is planned: "Leave the top quarter of the frame as clear empty background
for a caption." or "...the right third...">
No text, no letters, no numbers, no signs with writing, no logos, no watermark anywhere in the image.
```
`medias`: one `{"value": "<ref id>", "role": "image_references"}` per character in the shot. No references for shots without recurring characters.

Before starting, tell the viewer the count and credit cost (`setup.md`). Then send `generate_image_batch` calls of up to 12 shots (`index` = shot number), wait with `jobs_wait` (groups of up to 12), and append `"<n> <url>"` lines to `work/<slug>/raw/urls.txt`. Download, normalise to exactly 1920x1080 and make contact sheets:
```bash
python3 scripts/prep_images.py download --list work/<slug>/raw/urls.txt --dir work/<slug>/raw
python3 scripts/prep_images.py normalize --raw work/<slug>/raw --shots work/<slug>/timing/shots_timed.json \
    --out work/<slug>/shots --export "<media folder>/"
python3 scripts/prep_images.py contact --dir work/<slug>/shots --out work/<slug>/review --shots work/<slug>/timing/shots_timed.json
```
The media folder is the one the viewer will import into CapCut (route A: the mounted `CapCut Automation/<Video Name>/` folder itself; route B: `/mnt/user-data/outputs/<slug>/media/`, sent to the computer in step 8; route C: `work/<slug>/media/`, zipped in step 8). Keep anything else out of it. JPG names carry the timeline position (`07_0m21.0s.jpg`) so the viewer can find any shot.

## 6. Quality check and retakes

Look at every contact sheet yourself (Read the JPG) right after each batch and check each frame:
- shows what its line says (right action, right subject, readable at a glance)
- only the characters listed, each matching the sheet (outfit, colours, props); no extra copies of the lineup
- no text, letters, numbers or logos (common failure: signs, newspapers, documents with fake writing; ask for "blank paper" / "unreadable scribbles")
- nothing important cut off at the edges, and clear space where a caption is planned
- same style as the rest

Retake the misses straight away with a sharper prompt that names the fix ("only ONE soldier", "the newspaper is blank"). Allow two retakes per shot; if it still fails, simplify the visual. Re-run normalize and contact afterwards (it picks the newest file for each shot number, so name retakes `<n>_r1` etc. in urls.txt).

When the set is complete, send the viewer the contact sheets and the shot table so they can ask for changes, and move on to the edit.
