# Script and voiceover

## Contents
1. Writing the script
2. script.json
3. Choosing the voice
4. Generating the voiceover
5. Stitching, length and checks

## 1. Writing the script

**Length.** Aim for about 150 spoken words per finished minute (a natural TTS read is 130-140 wpm; stitching can speed it up gently, up to 1.15x). So 1 min = 150 words, 3 min = 450, 5 min = 750, 8 min = 1,200, 10 min = 1,500. Tell the viewer the word count and estimated length when you present the script.

**Research first.** For a true story or explainer, search the web and keep the sources. Every number, date and name in the script should trace to a source; if sources disagree, say "around" or pick the most reliable one and note it. Give the viewer the source list with the script (it also goes in their video description).

**Structure that holds attention:**
- Hook, first 10-15 seconds: lead with the most surprising true fact, stated plainly, then promise the story. Speak the video's main search phrase (the topic name people would type into YouTube) inside the first 15 seconds, naturally. YouTube reads the transcript, so spoken keywords early help the video get found.
- Context: just enough background to follow (who, where, why it mattered).
- 3-6 escalating beats, each ending on a turn ("Then...", "But...", "So...").
- Payoff: the outcome or the twist.
- Close: one line that lands the point, then a short call to action (one sentence).

**Write for the ear and for pictures:**
- Short sentences (mostly under 20 words). One idea per sentence, because each sentence usually becomes one shot.
- Concrete, drawable nouns and actions. "Soldiers loaded two machine guns onto a truck" is a picture; "the situation escalated" is not.
- Spell things the way they should be said: "World War One" not "WWI", "Doctor" not "Dr.", avoid symbols and abbreviations the voice might read oddly. Digits are fine for numbers and years ("1932", "20,000").
- No stage directions, headings or brackets in the text the voice reads.
- Humour and pauses come from rhythm: a very short sentence after a long one ("And the emus won.") lands as a beat.

**Scenes.** Split the script into 6-12 scenes at natural paragraph breaks (one beat each). Every scene must stay under 1,900 characters, because Higgsfield's voice model takes at most 2,048 characters per request. Scene breaks also become slightly longer pauses in the read.

**Approval.** Show the full script (scene by scene), word count, estimated length and sources. Wait for approval or edits before generating audio: changing words after the voiceover exists costs a regeneration.

## 2. script.json

Save the approved script as `work/<slug>/script.json`:
```json
{"title": "The Great Emu War", "keyword": "Great Emu War",
 "scenes": [{"n": 1, "text": "In 1932, Australia sent soldiers with machine guns to fight a war against 20,000 emus. And the emus won. This is the true story of the Great Emu War."},
            {"n": 2, "text": "After World War One, ..."}]}
```
The scene texts must be exactly what the voice reads. Everything downstream (timing, shot list, word indexes) is keyed to these words.

## 3. Choosing the voice

Call `list_voices` (size 50, page with `next_cursor` if needed). Pick three that suit narration for this topic (for example a warm documentary voice, an energetic storyteller, a calm explainer) and show each with its name and `preview_url` so the viewer can listen. If they have their own cloned voice it shows up as `voice_type: "element"`. If they say "you pick", choose the clearest warm narrator and say which.

## 4. Generating the voiceover

Model `seed_audio` with the chosen `voice_type` + `voice_id`. One request per scene, sent together with `generate_audio_batch` (up to 12 per call):
```json
{"index": 1, "params": {"model": "seed_audio", "prompt": "<scene 1 text>", "voice_type": "preset",
  "voice_id": "<id>", "format": "wav", "sample_rate": 48000}}
```
- `speech_rate` (0 = normal, positive = faster, about +10 is noticeably brisker) is the clean way to change pace. Use it if the viewer wants a faster read or the first scene runs well over the target pace.
- Wait with `jobs_wait` (groups of up to 12), then write a list file `work/<slug>/vo/urls.txt` with lines `scene01 <url>` and download:
  ```bash
  python3 scripts/prep_images.py download --list work/<slug>/vo/urls.txt --dir work/<slug>/vo
  ```
  (the download command works for any file type and names each file by its real format, e.g. `scene01.wav` or `scene01.mp3`; use the names it prints in the stitch command).
- If a submission times out, don't resubmit blindly: check the returned job ids first.

## 5. Stitching, length and checks

```bash
python3 scripts/stitch_vo.py --script work/<slug>/script.json \
  --clips work/<slug>/vo/scene01.wav work/<slug>/vo/scene02.wav ... \
  --out work/<slug>/vo/voiceover.wav --target-seconds <minutes x 60>
```
It trims each clip, joins them with half-second scene pauses, nudges the speed (0.87x-1.15x) to hit the target length, levels to -16 LUFS and writes `scenes.json` next to the output. If the natural read is too far from the target it keeps the natural speed and tells you; then trim or extend the script, or regenerate with `speech_rate`. Long voiceovers (over 28 MB) also get an `.m4a` copy: deliver and reference that one.

Then time the words (next step in SKILL.md):
```bash
python3 scripts/align_vo.py --scenes work/<slug>/vo/scenes.json --out work/<slug>/timing/words.json --names "proper nouns, comma separated"
```
With whisper available it prints how many script words it heard and lists the ones it didn't. A cluster of unheard words usually means the voice mispronounced, slurred or skipped something there. Tell the viewer the timestamp so they can listen, and offer to regenerate that one scene (spell the tricky word phonetically). Isolated unheard numbers or names are normally fine (whisper writes them differently).

It also notes any pause longer than 1.5 s inside a sentence (TTS voices sometimes add a dramatic pause). Either keep it and plan a beat there in the edit, or regenerate that scene.

Send the voiceover to the viewer (SendUserFile) so they can listen while you carry on. Regenerating one scene later is cheap; just re-run stitch, align and the shot timing afterwards because every timestamp moves.
