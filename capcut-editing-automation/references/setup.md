# Setup: tools, computer access, folders, costs

Read this at the start of every run. Most problems come from finding out mid-video that a tool or folder isn't there.

## Contents
1. What the run needs
2. The three ways Claude can reach the viewer's computer
3. Folders to ask for (Mac and Windows)
4. Python environment
5. Downloads from Higgsfield
6. Cost estimate to show the viewer

## 1. What the run needs

| Need | How to check | If missing |
| --- | --- | --- |
| Code execution (Python, files) | you can run `python3 scripts/check_env.py` | Ask the viewer to turn on Settings > Capabilities > "Code execution and file creation" and start a new chat. |
| Higgsfield connector | `mcp__Higgsfield__*` tools exist (load `balance`, `generate_audio`, `generate_image_batch`, `jobs_wait` with ToolSearch if deferred) | Ask them to connect Higgsfield in Settings > Connectors (or use the connector suggestion card if available), then reply "done". Nothing can be generated without it. |
| Higgsfield credits | call `balance` | Show the estimate (section 6) and let them top up before generating. |
| CapCut desktop | ask | Mac or Windows desktop app (not the phone app or web editor). |
| Their sound library | ask where it is | They point you to their own music + sound effects folder (any structure). If they have none, offer: skip sounds, or they drop a few files into one folder. |
| Access to their computer | section 2 | Fall back to the upload / download route. |

Run once at the start:
```bash
python3 scripts/check_env.py --whisper
```
It installs numpy, Pillow, scipy and a bundled ffmpeg if needed, and tries to load the faster-whisper model for word timing. If whisper can't download its model, that's fine: timing falls back to pause-based alignment (sentence starts match whisper exactly in testing; individual words land within about 0.2 s).

## 2. The three ways Claude can reach the viewer's computer

Work out which one applies before promising anything, by looking at the tools you actually have.

**A. Shell on the viewer's computer, folders mounted** (Claude desktop app working directly in folders the viewer connected). You run the scripts right next to their files. Connected folders appear as mounted paths. The path CapCut needs is the folder's real path on the computer (for example `/Users/sam/Movies/...` or `C:\Users\sam\Videos\...`), never the mount path, so note both for every folder: the mount path is "local", the real path is "device".

**B. Cloud session linked to the computer** (`mcp__remote-devices__*` tools: `get_device_info`, `device_list_dir`, `device_stage_files`, `device_commit_files`, `device_bash`, `device_request_folder_access`). Scripts run in the cloud workspace. Files move like this:
- computer to workspace: `device_stage_files` (lands in `/mnt/user-data/uploads/<folder name>/<relative path>`)
- workspace to computer: `device_commit_files` (source must sit under `/mnt/user-data/outputs/`; at most 50 files, 30 MB each, 100 MB per call)
- `device_bash` runs commands in a small Linux VM where connected folders appear at `$HOME/mnt/<folder name>`. Use it to search folders and grep files. It cannot see or quit apps.
- `get_device_info` gives the platform (`darwin` = Mac, `win32` = Windows) and the real paths of the connected folders.

**C. No access** (none of the above). Use the upload / download route: Claude sends zips, the viewer unzips, imports and uploads two small project files back, then runs a double-click installer. See `capcut-edit.md`, "Route C".

If the conversation shows the device tools but calls fail ("no device connected"), the computer is asleep or the desktop app is closed. Ask them to wake it and open the app, and keep going with the parts that don't need it (script, voice, images).

## 3. Folders to ask for

Ask once, for all of them together (in B use `device_request_folder_access` with every path in one call and a one-line reason; in A ask the viewer to add them with the app's folder button).

**Mac**
- CapCut projects: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft`. Asking for `~/Movies` covers this AND gives you a place for the video's media (`~/Movies/CapCut Automation/<Video Name>/`), so prefer `~/Movies`.
- Their sound library: wherever they say (for example `~/Documents/Sound Library`, `~/Music/SFX`).
- Optional, for pixel-exact caption measuring: `/Applications/CapCut.app/Contents/Resources/Font/SystemFont` (contains CapCut's `en.ttf`; stage it and pass `--capcut-font`).

**Windows**
- CapCut projects: `C:\Users\<name>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft` (AppData is hidden, so give the full path). If they moved it, CapCut shows the location under Settings > Projects / Draft location.
- A media folder for the video: `C:\Users\<name>\Videos` (you create `CapCut Automation\<Video Name>\` inside it).
- Their sound library.

Use the home folder name from `get_device_info` (or ask) rather than guessing it.

Don't stage or copy their whole sound library. Search it on the computer (see `capcut-edit.md`, "Finding sounds"), then stage only the files you will use.

## 4. Python environment

- Scripts live in this skill's `scripts/` folder; run them with `python3 scripts/<name>.py` from the skill folder or with full paths. They import each other, so keep them together.
- Keep each video's files in one working folder, for example `work/<video-slug>/`. In route B put the folders you will send to the computer under `/mnt/user-data/outputs/<video-slug>/` so `device_commit_files` can send them.
- pip may need `--break-system-packages` (check_env.py handles it).

## 5. Downloads from Higgsfield

Generated files come back as URLs (often on a `cloudfront.net` domain). Test once with the first result:
```bash
python3 scripts/check_env.py --url "<first result url>"
```
If it reports BLOCKED, the viewer's code-execution network settings don't allow that domain. Ask them to allow it (Settings > Capabilities, network / allowed domains: add the domain from the URL, or allow all domains), then retry. Don't try other download tricks.

## 6. Cost estimate to show the viewer

Get real prices with `get_cost: true` on one image and one voiceover scene before quoting, because prices change. Prices measured in October 2026: GPT Image 2.5 (high quality, 2k, 16:9) 2.75 credits per image; Seed Audio voiceover about 6.5 credits per 1,000 characters of script.

| Length | Words | Shots (about 1 per 4 s) | Images incl. sheet + retakes | Rough total credits |
| --- | --- | --- | --- | --- |
| 1 min | ~150 | ~15 | ~20 | ~60 |
| 3 min | ~450 | ~45 | ~55 | ~170 |
| 5 min | ~750 | ~75 | ~90 | ~280 |
| 8 min | ~1,200 | ~120 | ~140 | ~430 |
| 10 min | ~1,500 | ~150 | ~175 | ~540 |

Show the estimate before generating anything, and say what a retake costs (one image price) so they can decide how picky to be.
