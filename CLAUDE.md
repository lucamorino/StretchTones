# Distributed Sound Installation — Project Context

Handoff notes for continuing this build in Claude Code. This captures decisions
already made in an earlier planning session; treat them as settled unless the
maintainer says otherwise.

## What this is

A web-based sound installation. A **7-channel ambient/drone composition** is
diffused across the audience's own phones — each phone plays **one** channel, so
the crowd collectively becomes a distributed loudspeaker orchestra. Visitors open
a URL, tap a single play button, and pocket the phone.

## Hard requirements (in priority order)

1. **Lock-screen survival is paramount.** Audio must keep playing when the phone
   is locked or the browser is backgrounded. This is non-negotiable.
2. **Synchronized playback**, but with a *relaxed* tolerance: **50–100 ms of
   inter-device drift is acceptable.** The 7 tracks are independent drone
   textures, so there is no comb-filtering risk from small offsets even though
   listeners are co-located and hear multiple phones at once.
3. **Mobile-first.** Must work on iOS Safari and Android Chrome.
4. Hosted on the maintainer's **GitHub Pages** site (free, static).

## Settled architecture — DO NOT reintroduce a streaming server

- **Fully static. No Icecast, no Liquidsoap, no VPS.** Icecast was considered and
  rejected: it is a live-broadcast model with per-client buffering and no shared
  clock, so it cannot synchronize devices (they end up seconds apart).
- **Playback = a plain `<audio>` element**, NOT the Web Audio API. This is the
  crux of requirement #1: `AudioContext` gets suspended when the phone locks; an
  `<audio>` media element keeps playing. The cost is that we can only *seek*
  (`currentTime`), so sync is ~tens of ms, not sample-accurate — which is why the
  relaxed tolerance above matters.
- **Each phone downloads its one file once and loops it locally** (`loop=true`).
  After buffering there is no network dependency, which makes locked-screen
  playback bulletproof (nothing to stall). Bandwidth = filesize × visitors, once.
- **Sync via the device's own NTP-synced clock.** Position is phase-locked to the
  Unix epoch: `position = (Date.now()/1000) % duration`, computed independently on
  each device. No time server needed. (A free Cloudflare Worker returning
  `Date.now()` is the escape hatch if we ever measure the spread as too loose —
  but for this piece we expect not to need it.)
- **Media Session API** registers the OS-level media session that keeps the
  session alive in the background and shows lock-screen controls.

## Channel assignment

- Preferred: **7 QR codes placed around the room**, each pointing at the same page
  with `?ch=1` … `?ch=7`. This lets the maintainer *compose the spatial field*
  (decide where each channel physically lives) and avoids the silent-channel
  clumping that pure random assignment causes at small crowds.
- **Random fallback** is wired in `sync-engine.js` for anyone opening a bare link
  (no `?ch`): picks uniformly among the 7 channels.

## Audio files

- Delivered as **7 separate stereo AAC/m4a files**
  (`public/assets/StretchTones_Tracks/Track{1..7}.m4a`), one per channel —
  already split, not one packed multichannel file. Each phone gets a full
  stereo mix for its channel (headphone-style), not a mono spatial slice.
- **RESOLVED — stereo vs. mono:** confirmed stereo (2ch, 44.1kHz) via `ffprobe`.
- **RESOLVED — exact loop length:** container/format duration
  (`ffprobe format=duration`) reads **1592.354830s**, but is *not* trustworthy
  per the gotcha above (~48ms off here). Decoding full PCM and counting samples
  (`70220736 samples / 44100 Hz`) gives the true value used as the `duration`
  constant in `index.html`: **1592.3069387755102s**. All 7 files decode to the
  identical sample count, so they are already loop-aligned.
- **Superseded — original MP3 stems:** the project originally shipped as
  `public/assets/stem/Tones- N-stretch-N.mp3` (62MB each, 1628.0032653061225s
  loop). Replaced 2026-07-07 with the smaller AAC set above after real-device
  testing (iPhone, Chrome) showed continuous playback interruptions — diagnosed
  as buffering not completing before the phone locked and background fetches
  got throttled (see next section). The old `stem/` folder is still on disk but
  unreferenced; safe to delete once the AAC set is confirmed good on-device.
  AAC also carries gapless (iTunSMPB) metadata that mobile decoders honor more
  reliably than the old files' LAME MP3 padding, which was a separate,
  previously-flagged loop-seam-click risk.

## Buffering-before-lock (root cause of the interruption bug)

- The phase-lock design seeks `currentTime` to an arbitrary mid-file position
  immediately on tap, then expects `loop=true` to run with no further network
  dependency. That promise only holds once the *entire* file is buffered —
  and on iOS, backgrounded/locked tabs get their network fetches throttled, so
  if the file isn't fully downloaded by the time the visitor pockets the phone,
  playback stalls until the next foreground moment.
- `index.html` now tracks this directly: the loader
  (`public/images/loader.gif`) stays visible until `audio.buffered` covers the
  full `duration`, not just until `canplaythrough` (which only means "enough
  buffered to play right now," not "safe to lock"). This is a UI signal only —
  it doesn't block playback, which still starts immediately on tap per the
  phase-lock design.
- Smaller files (AAC vs. the old MP3s) matter because they shrink the window
  between tap and full-buffer completion, directly reducing how often a visitor
  locks the phone before that point.

## Gotchas to respect

- HTTPS everywhere. If the page is HTTPS (GitHub Pages is), every audio URL and
  any fetch must be HTTPS too, or the browser silently blocks mixed content.
- Do **not** set `crossOrigin` on the `<audio>` element — plain cross-origin
  playback needs no CORS, and setting it would require CORS headers and could
  break playback.
- GitHub Pages has a soft bandwidth cap (~100 GB/month). For a long/high-traffic
  run, front the same repo files with **jsDelivr** (free CDN off the repo) or move
  audio to **Cloudflare R2** (free tier, no egress). Both stay serverless.
- The drift-correction loop is throttled while backgrounded; it re-converges on
  return to foreground. This is expected and fine.

## Current state / next steps

- `sync-engine.js` exists (clock-synced looping playback + drift correction via
  `playbackRate` + Media Session), with the channel-selection fallback now
  randomized per [[Channel assignment]] above.
- `index.html` is the minimal front end: a black page with a single play/pause
  button (`public/images/play.png` / `stop.png`, swapped on state) in the
  top-left corner, plus `public/images/loader.gif` shown until the file is
  fully buffered (see Buffering-before-lock above). It imports `createPlayer`
  from `sync-engine.js` with the 7 local channel paths and the exact `duration`
  constant above. `player.html` (an earlier Icecast/manual-channel-switcher
  mockup, architecturally incompatible with the settled design) has been
  removed in favor of this.
- Note: the current AAC files are ~25MB each (175MB total). The superseded MP3
  stems were 62MB each (435MB total) — well under GitHub's 100MB hard per-file
  limit either way, but consider Git LFS if the 50MB soft-warning threshold
  becomes a nuisance.
- TODO:
  1. ~~Confirm stereo-vs-mono and exact loop length.~~ Done — see Audio files.
  2. ~~Provide the `ffmpeg` split command.~~ Not needed — files arrived pre-split.
  3. ~~Wire `createPlayer({...})` behind the play button.~~ Done — `index.html`.
  4. Set up the GitHub Pages repo structure and deploy (repo has no build step;
     `index.html` at root should just work as the Pages entry point).
  5. Test on a real locked iPhone and a locked Android device — including a
     listening check for the MP3 gapless-loop risk noted above.
  6. Generate the 7 QR codes (`?ch=1..7`).

## Working style

Maintainer is a PhD researcher in music technology / HCI / experimental music.
Prefers precise technical terminology, prose-dominant explanations with light
headers, and surgical edits that preserve his own voice and code.
