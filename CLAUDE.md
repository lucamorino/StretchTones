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
- **Update 2026-07-07: full pre-buffering shipped, interruptions persisted.**
  This ruled out buffering/network as the cause entirely and pointed at the
  drift-correction loop itself — see next section.

## Drift-correction loop was the actual interruption source

- **Root cause:** `startDrift()` polled every **2s** and would hard-reseek
  (`audio.currentTime = targetPos()`) past **250ms** of measured drift, or
  nudge `playbackRate` past just **30ms**. But `audio.currentTime` reads carry
  real measurement jitter from JS timer scheduling on mobile — commonly tens
  of ms, more under load — which alone was enough to cross a 30ms threshold on
  nearly every single tick, with zero real clock drift involved. Every such
  crossing changed `playbackRate` or hard-reseeked, and both are known to
  produce an audible pop/glitch on iOS Safari's `<audio>` pipeline. Polling
  every 2s made this effectively continuous.
- **Why the thresholds were wrong in the first place:** the hard requirement
  is 50-100ms tolerance *across devices*. There is no reason to correct a
  single device's own sub-100ms jitter at all. A phone's audio clock drifts
  only a few ms per minute, so real accumulated drift over the entire
  ~26-minute loop stays well under a second — nothing here needs fast or
  frequent reaction.
- **Fix, in `sync-engine.js`:** poll interval raised to 10s; `SOFT` (start
  nudging `playbackRate`) raised to 70ms; `HARD` (act on persistent drift)
  raised to 1s; acting on HARD drift now requires **two consecutive**
  over-threshold reads, to filter one-off measurement glitches (e.g. a check
  landing right on the loop seam) rather than reacting to a single noisy
  sample.
- **Update 2026-07-07: even with these looser thresholds, real-device testing
  (iOS) still showed 3-5 interruptions/minute.** Any HARD-level correction was
  still cutting via `audio.currentTime = targetPos()`, and a hard reseek is
  audibly a splice regardless of how rarely it fires — the remaining
  interruptions were exactly these reseeks. The fix needed to change what a
  HARD correction *does*, not just how often it happens.

## "Vinyl touch" correction — no reseek, no cut

- Persistent HARD-level drift (two consecutive reads past 1s) no longer
  reseeks. Instead `vinylTouch()` bends `playbackRate` away from 1x and eases
  back over `TOUCH_S` = 1 second, shaped as a half-sine so the rate is
  *exactly* 1x at both the start and end of the bend — there is no
  discontinuity to hear, by construction, unlike a reseek which always is one.
  Modeled on a DJ nudging a turntable back into phase rather than a jump-cut.
- The bend's peak deviation scales with how far off we are (`Math.abs(drift) *
  π / (2·TOUCH_S)`), clamped to `TOUCH_MIN_DEV`/`TOUCH_MAX_DEV` (±5%..±50%
  playbackRate) — barely-there near the threshold, a real pitch-bend for a
  bigger gap. If one bend doesn't fully close a large gap (clamped at 50%), the
  residual just gets picked up by the next check, either another bend or
  routine soft nudging.
- `RESEEK_SANITY_S` (6s) is the one remaining fallback to an instant reseek:
  a gap that large can't plausibly be closed by any tasteful bend (this is the
  scenario for e.g. minutes of background-throttled JS after a long lock), so
  it isn't worth trying — a rare, expected cut in an edge case that shouldn't
  come up during normal listening.
- Not yet confirmed on a real locked iPhone as of 2026-07-07 — this is the
  next thing to test.

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
