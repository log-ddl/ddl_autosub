# TTS providers

The TTS tab keeps OmniVoice and adds CapCut, ElevenLabs (through the CapCut
`11labs` common-task route), SonicVoice (`https://sonicvoice.pro/api`), and local
VieNeu v3 Turbo CPU. This does not add CapCut editor integration. Online voices
require an internet connection; service availability is decided by the remote
service, not by the bundled catalog.

## Voice selection

- Search names or complete/partial provider voice IDs within the bundled catalog.
- Provider voice IDs are hidden in the list and selected-voice card, but remain searchable.
- Language filters use localized English/Vietnamese names; rows retain short language codes.
- Rows show gender icons with accessible labels; unknown gender uses a neutral icon.
- Favorite voices persist by provider/language/ID and have a dedicated filter.
- Listen to a fixed sample in the voice language. Preview uses the same generation path,
  caches results in the session, plays one sample at a time, and supports stop/cancel.
  Preview never clears the text editor or adds an entry to generation history.
- Filter online voices by language and ElevenLabs voices by gender.
- Render 40 matches per page; never mount the entire 9,437-voice ElevenLabs list.
- Persist selections per provider, keyed by language and provider ID. Send the
  actual provider ID (not the UI selection key) to synthesis.
- Existing history, export, folder batches, line/sentence splitting and cancel
  use the same TTS controller and backend dispatch.

## Runtime

CapCut/ElevenLabs run in Rust without a Python/model install. The bundled voice
index, RSA public key, device identity, and keep-alive HTTP client are cached in
memory. Requests submit once, poll adaptively (`450ms` ramping to `2000ms`) for
up to 180 seconds with transient query retries, surface provider error details,
and validate returned MP3 data; downloads only allow known HTTPS media domains,
without redirects. Line and sentence split modes synthesize up to 4 parts
concurrently for online providers while keeping local models sequential. Cancel
stops waiting and network activity but cannot recall a task already accepted by
the service.
Protocol attribution is bundled at `resources/tts/LICENSE-capcut-tts.txt`.

VieNeu has its own managed Python environment under app data `runtimes/vieneu`,
with `vieneu==3.8.3`, separate from OmniVoice. Install builds that environment
and initializes the ONNX CPU model; `.ready` is only written after initialization
succeeds. It supports presets and reference audio from saved voice profiles.
First installation needs internet and downloads the model. Model inference has
not been verified merely by a successful TypeScript/Rust build.

The online catalog is a snapshot, not a promise every listed voice is usable.
No ElevenLabs API key is required for this CapCut-backed route. This is not the
official ElevenLabs API adapter.

### SonicVoice (`sonicvoice.pro`)

SonicVoice runs in Rust (`src-tauri/src/tts/sonicvoice.rs`) using an `X-API-Key`
saved in Settings (`sonicvoiceApiKey`, or `SONICVOICE_API_KEY` env fallback).
It exposes:
- Both Minimax (`mini`) and ElevenLabs (`eleven`, including Vietnamese) voices
  under one account, plus live character balance (`GET /v1/me/balance`) and
  model pricing/capabilities (`GET /v1/models`).
- Instant Minimax voice cloning (`POST /v1/voices/clone`, `uv_*` IDs usable
  immediately in TTS jobs) and deletion (`DELETE /v1/voices/{voice_id}`).
- Direct `preview_url` playback in the voice browser when available so voice
  previews do not consume account characters.
- Native server-side batch splitting (`kind: "batch"`, `texts[]`) for line and
  sentence split modes, followed by local FFmpeg merging and `.srt` generation.
- Remote job cancellation (`DELETE /v1/tts/jobs/{job_id}`) so SonicVoice refunds
  unused characters when a running job is cancelled.

## Multi-speaker Dialogue & MCP

- Scripts containing paired speaker tags wrapped on both ends (`[A] ... [A]`, `[ID1] ... [ID1]`, or `[A] ... [/A]`) switch to multi-speaker dialogue synthesis (`tts::dialogue`). All text outside paired speaker tags uses the default Narrator voice, whether inline in the same paragraph or across multiple lines. Emotion/stage tags (`[laugh]`, `[sigh]`, `[pause]`, ...) and single brackets (`[1]`, `[note]`) are ignored.
- Speakers can mix providers freely (`capcut`, `vieneu`, `omnivoice`, `elevenlabs`, `sonicvoice`, or saved cloned voice profiles synced to `<app_data>/tts/profiles.json`). Online turns run with up to 4 concurrent requests while local models serialize safely.
- Every split or dialogue run writes a matching `.srt` file alongside the merged audio and returns per-turn `turns` timings (`startSec`, `endSec`, `speaker`, `text`).
- The app-wide MCP server exposes `list_tts_voices` and `generate_speech` (`src-tauri/src/ai_edit/mcp/tools/tts.rs`) for both in-app AI Edit and external agents (`autosubs-app` on port `47185`), working both with an open Premiere project (saving into `<workspace>/media/audio/voice/` with short media IDs) and standalone (saving into `<studio_home>/voice/`).

## Verification

From `AutoSubs-App/`:

```
npm run build:web
cd src-tauri
cargo check --no-default-features --features mac-aarch
cargo test --no-default-features --features mac-aarch tts::providers
```

The ignored `live_online_routes` test explicitly submits one short request per
online provider. Run only when a live generation is intended:

```
cargo test --no-default-features --features mac-aarch live_online_routes -- --ignored --nocapture
```

## Validation on 2026-11-10

- Production web build and Rust mac-aarch check passed.
- Four native protocol/catalog tests passed.
- Explicit native live test returned valid audio for both ElevenLabs and CapCut.
- Two model-free Python worker protocol tests passed (preset, reference audio, initialization).
- Full VieNeu model installation/inference has not been exercised.

## Voice browser validation on 2026-11-10

- Four voice-catalog tests pass (ID lookup, favorite/filter intersection, provider scope, locale/sample coverage).
- Production web build passes.
- UI exercised with real TTS components and mocked Tauri transport: English/Vietnamese
  language menus, hidden-ID lookup, persisted favorites across reload, preview playback,
  cache reuse, stop during generation and suppression of late playback. Editor text and
  history remain unchanged by previews. No live provider request was needed for these UI tests.
