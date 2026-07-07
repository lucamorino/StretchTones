/*
  sync-engine.js — synchronized, lock-screen-safe looping playback
  ------------------------------------------------------------------
  Model: pre-recorded file, downloaded once, looped locally, its phase
  locked to a shared clock so every device plays the same moment.

  WHY <audio> AND NOT WEB AUDIO: a media element keeps playing when the
  phone locks; AudioContext gets suspended. The cost is that we can only
  SEEK (currentTime), so realistic cross-device sync is ~20–50 ms, not
  sample-accurate. That is the deliberate trade for background playback.

  WHY fetch() TO A Blob INSTEAD OF audio.src = url DIRECTLY: iOS WebKit
  (every iOS browser, Chrome included, runs on WebKit) does not reliably
  honor preload="auto" — it can defer the actual download until close to
  a user gesture, so "buffered enough by the time the phone locks" is not
  guaranteed. Once locked, background media fetches get throttled hard,
  so a still-downloading tail stalls repeatedly. A plain fetch() is not
  subject to that media-preload throttling, and once the bytes are a
  Blob there is zero remaining network dependency — not "probably
  buffered," but nothing left to fetch, ever, including across the loop
  seam. play() is gated until the fetch resolves (see `ready`/`onProgress`).

  WIRING (your existing button):
      import { createPlayer } from './sync-engine.js';
      const player = createPlayer({
        channels: [ 'https://audio.you.org/ch1.aac', ... 8 urls ... ],
        duration: 612.0,                       // EXACT loop length in seconds
        timeUrl:  'https://audio.you.org/time', // omit to trust device clocks
        title:    'Installation Title',
        onProgress: frac => { ... },           // 0..1 download progress
      });
      document.getElementById('playBtn')
              .addEventListener('click', () => player.toggle()); // no-ops until player.ready
*/

export function createPlayer({ channels, duration = null, timeUrl = null, title = 'Installation', onProgress = null }) {
  // --- pick this visitor's channel from ?ch=N (1-based); bare link falls back to random ---
  const params = new URLSearchParams(location.search);
  const chParam = params.get('ch');
  const n = chParam ? Math.min(Math.max(parseInt(chParam, 10), 1), channels.length)
                     : 1 + Math.floor(Math.random() * channels.length);
  const url = channels[n - 1];

  // diagnostic escape hatches for isolating the cause of playback interruptions:
  //   ?nosync=1   — seek once at tap, then NO further correction at all (tests whether
  //                 corrections are the cause, or the glitches happen independent of them)
  //   ?synclog=1  — console.debug every correction with a timestamp, for correlating
  //                 against what you hear (open Safari's remote Web Inspector: connect
  //                 the iPhone to a Mac, then Safari > Develop > [device] > this page)
  //   ?nocache=1  — bypass the HTTP cache and force a real fresh download, so the
  //                 progress UI is exercised for real instead of resolving instantly
  //                 from a previous test's cached response
  const noSync = params.has('nosync');
  const syncLog = params.has('synclog');
  const noCache = params.has('nocache');
  function logCorrection(type, drift, extra = '') {
    if (syncLog) console.debug(`[sync] ${new Date().toISOString()} ${type} drift=${drift.toFixed(3)}s ${extra}`);
  }

  const audio = new Audio();
  audio.loop = true;                 // loop locally — no network during playback
  audio.setAttribute('playsinline', ''); // iOS: never go fullscreen
  // NOTE: do NOT set crossOrigin — plain playback across origins needs no CORS.

  let ready = false;

  // --- download the whole file into memory before it ever touches <audio>, retrying on failure ---
  async function fetchWholeFile() {
    for (;;) {
      try {
        const res = await fetch(url, { cache: noCache ? 'no-store' : 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        const declaredType = res.headers.get('content-type') || '';
        // a Blob's declared type is what <audio> uses to decide it can play it —
        // fall back to audio/mp4 if the host mis-declares .m4a (e.g. octet-stream)
        const type = declaredType.startsWith('audio/') ? declaredType : 'audio/mp4';

        let blob;
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          const chunks = [];
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (onProgress) onProgress(total ? received / total : 0);
          }
          blob = new Blob(chunks, { type });
        } else {
          blob = await res.blob(); // fallback: no fine-grained progress
        }

        audio.src = URL.createObjectURL(blob);
        ready = true;
        if (onProgress) onProgress(1);
        return;
      } catch {
        if (onProgress) onProgress(0); // signal "still not ready" and try again
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  const readyPromise = fetchWholeFile();

  const ANCHOR_MS = 0;               // loop phase-locked to the Unix epoch
  let clockOffset = 0;               // serverTime - clientTime, in ms
  let driftTimer = null;

  const loopLen = () => duration || audio.duration || 0;
  const serverNow = () => Date.now() + clockOffset;
  const targetPos = () => {
    const D = loopLen();
    return D ? (((serverNow() - ANCHOR_MS) / 1000) % D + D) % D : 0;
  };

  // --- clock handshake: keep the sample with the smallest round-trip ---
  async function syncClock(samples = 5) {
    if (!timeUrl) { clockOffset = 0; return; }   // fall back to the device's own NTP clock
    let best = Infinity;
    for (let i = 0; i < samples; i++) {
      try {
        const t0 = Date.now();
        const { t } = await (await fetch(timeUrl, { cache: 'no-store' })).json();
        const t1 = Date.now();
        const rtt = t1 - t0;
        if (rtt < best) { best = rtt; clockOffset = (t + rtt / 2) - t1; }
      } catch { /* keep whatever we have; device clock is the fallback */ }
    }
  }

  // --- vinyl-touch drift correction: no reseek, no cut ---
  // Every check measures how far off we are and, if that's above a jitter floor,
  // bends playbackRate away from 1x and back over a fixed TOUCH_S window — like a DJ
  // nudging a turntable back into phase rather than a jump-cut. The ramp is a plain
  // linear up-then-down slope (not a sine): it starts and ends at exactly 1x by
  // construction, so there's no discontinuity at either boundary regardless of shape.
  //
  // The peak rate is derived straight from the definition of "average rate": to erase
  // `drift` seconds over a TOUCH_S-second window, the audio must advance
  // (TOUCH_S - drift) seconds of content while TOUCH_S seconds of real time pass, i.e.
  // avgRate = 1 - drift/TOUCH_S. A symmetric 1→peak→1 ramp has avgRate = (1+peak)/2, so
  // peak = 1 - 2*drift/TOUCH_S. E.g. arriving 1s late (drift=-1, TOUCH_S=1) gives
  // peak=3 (ramp from 1x up to 3x and back, covering 2s of file in 1s of real time);
  // arriving 0.5s early (drift=+0.5) gives peak=0 (ramp down toward a near-stop and
  // back, covering just 0.5s of file in that same 1s). Peak scales proportionally with
  // the size of the drift, clamped to a full octave either way (x0.125..x8) as a hard
  // safety bound — a gap too big to close in one touch is smaller by the next check
  // and gets picked up then.
  const CHECK_MS = 10000;              // ms between checks
  const TOUCH_THRESHOLD = 0.070;       // seconds — below this, do nothing (single-device jitter floor)
  const TOUCH_S = 1.0;                 // duration of one touch, in real seconds
  const RATE_MIN = 0.125, RATE_MAX = 8; // hard playbackRate bounds (one octave down / up)
  const RESEEK_SANITY_S = 20.0;        // beyond this, no plausible touch closes the gap fast enough — just cut
  let overSanityStreak = 0;
  let touchTimer = null;
  let touching = false;

  function vinylTouch(drift) {
    touching = true;
    clearInterval(touchTimer);
    const peak = Math.min(Math.max(1 - 2 * drift / TOUCH_S, RATE_MIN), RATE_MAX);
    logCorrection('touch-start', drift, `peak=${peak.toFixed(3)}x`);
    const t0 = performance.now();
    const half = TOUCH_S / 2;
    touchTimer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      if (t >= TOUCH_S || audio.paused) {
        audio.playbackRate = 1;
        touching = false;
        clearInterval(touchTimer);
        logCorrection('touch-end', drift);
        return;
      }
      // linear ramp: 1 -> peak over the first half, peak -> 1 over the second half
      audio.playbackRate = t < half
        ? 1 + (peak - 1) * (t / half)
        : peak + (1 - peak) * ((t - half) / half);
    }, 50);
  }

  function startDrift() {
    clearInterval(driftTimer);
    clearInterval(touchTimer);
    overSanityStreak = 0;
    touching = false;
    if (noSync) return; // diagnostic: seek once at tap, then leave it alone entirely
    driftTimer = setInterval(() => {
      if (audio.paused || !loopLen() || touching) return;
      const D = loopLen();
      let drift = audio.currentTime - targetPos();      // + means we are ahead
      if (drift >  D / 2) drift -= D;                    // choose nearest across the loop seam
      if (drift < -D / 2) drift += D;

      if (Math.abs(drift) < TOUCH_THRESHOLD) {
        overSanityStreak = 0;
        return; // within single-device jitter — nothing to correct
      }

      if (Math.abs(drift) > RESEEK_SANITY_S) {
        // require two consecutive over-threshold reads before an audible cut — filters
        // one-off measurement glitches (e.g. a check landing right on the loop seam)
        if (++overSanityStreak >= 2) {
          overSanityStreak = 0;
          logCorrection('reseek', drift);
          audio.currentTime = targetPos();
          audio.playbackRate = 1;
        }
        return;
      }

      overSanityStreak = 0;
      vinylTouch(drift);
    }, CHECK_MS);
    // (this loop is throttled while backgrounded — it re-converges on return to foreground)
  }

  function setMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: `Channel ${n}`, album: `${n} / ${channels.length}`,
    });
    navigator.mediaSession.setActionHandler('play',  () => play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  }

  function play() {
    if (!ready) return; // whole file must be a local Blob first — see fetchWholeFile
    // MUST run synchronously inside the user gesture on iOS. Clock is already
    // synced (on load + periodically), so we can seek and play immediately.
    audio.currentTime = targetPos();
    audio.play().catch(() => {/* autoplay refused until a real tap */});
    startDrift();
    setMediaSession();
  }

  // sync the clock now, and refresh it every 30 s so the gesture path stays instant
  syncClock();
  setInterval(syncClock, 30000);

  return {
    toggle: () => (audio.paused ? play() : audio.pause()),
    play,
    pause: () => audio.pause(),
    get playing() { return !audio.paused; },
    get ready() { return ready; },
    whenReady: readyPromise,
    audio,   // exposed if you want to reflect state on your button
  };
}
