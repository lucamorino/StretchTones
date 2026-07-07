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

- **First attempt (insufficient):** relied on `audio.preload = 'auto'` to
  download in the background, gating a "safe to lock" loader on
  `audio.buffered` covering the full duration. Smaller AAC files (this section
  originally recommended the switch) reduced but did not eliminate real-device
  interruptions on iPhone.
- **Root cause:** iOS WebKit (every iOS browser, Chrome included, runs on
  WebKit) does not reliably honor `preload="auto"` — it can defer the actual
  download until close to a user gesture. So "buffered enough by the time the
  phone locks" was never guaranteed in the first place. Once locked, background
  media fetches get throttled hard, so a still-downloading tail stalls
  repeatedly. This is orthogonal to file size — it's a scheduling problem, not
  a bandwidth problem.
- **Current fix, in `sync-engine.js`:** the whole file is downloaded with a
  plain `fetch()` into an in-memory `Blob` *before* the play button is ever
  enabled — a plain `fetch()` is not subject to WebKit's media-preload
  throttling. `audio.src` is only ever set to the resulting `URL.createObjectURL(blob)`,
  never to the network URL directly. Once that resolves there is categorically
  zero remaining network dependency: not "probably buffered," but nothing left
  to fetch, ever, including across the loop seam. `player.ready` /
  `player.whenReady` gate playback; `index.html` disables the button and shows
  live download percentage (`onProgress`) until then. Fetch failures retry
  automatically every 3s (gallery wifi can be flaky).
- Trade-off: the visitor now waits for a full download before they can tap
  play, rather than tapping immediately and hoping buffering keeps up. For a
  ~25MB AAC file on gallery wifi this should be a few seconds — an acceptable
  cost for a guarantee instead of a probabilistic race.
- Still worth testing on a real locked iPhone: this removes the buffering race
  entirely, but hasn't yet been confirmed on-device as of 2026-07-07.

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
