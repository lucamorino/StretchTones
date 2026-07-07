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
  const chParam = new URLSearchParams(location.search).get('ch');
  const n = chParam ? Math.min(Math.max(parseInt(chParam, 10), 1), channels.length)
                     : 1 + Math.floor(Math.random() * channels.length);
  const url = channels[n - 1];

  const audio = new Audio();
  audio.loop = true;                 // loop locally — no network during playback
  audio.setAttribute('playsinline', ''); // iOS: never go fullscreen
  // NOTE: do NOT set crossOrigin — plain playback across origins needs no CORS.

  let ready = false;

  // --- download the whole file into memory before it ever touches <audio>, retrying on failure ---
  async function fetchWholeFile() {
    for (;;) {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
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

  // --- gentle convergence: nudge playbackRate; bend back into phase instead of cutting ---
  // Thresholds and polling are deliberately loose. The design tolerates 50-100ms of
  // drift ACROSS devices, so there is no reason to correct a single device's own
  // jitter below that. A modern phone's audio clock drifts only a few ms per minute,
  // so real accumulated drift over the whole ~26-minute loop stays well under a
  // second — there is no need to react quickly or often.
  const CHECK_MS = 10000;            // ms between checks
  const SOFT = 0.070, HARD = 1.0;    // seconds — comfortably above single-device measurement jitter
  const RATE_CLAMP = 0.02;           // max ±2% routine playbackRate nudge

  // For persistent HARD-level drift, a "vinyl touch" instead of a reseek: like a DJ
  // nudging a turntable, playbackRate bends away from 1x and eases back over TOUCH_S
  // seconds — a shaped half-sine so it starts and ends at exactly 1x, i.e. no
  // discontinuity, ever. Depth scales with how far off we are: barely audible near
  // the threshold, a real pitch-bend for a bigger gap. A hard reseek (audible cut)
  // is a last resort, reserved for gaps too large for any plausible bend to close
  // (e.g. minutes of background throttling after the phone was locked a long time).
  const TOUCH_S = 1.0;                // duration of one "touch"
  const TOUCH_MIN_DEV = 0.05, TOUCH_MAX_DEV = 0.5; // playbackRate deviation range (±5%..±50%)
  const RESEEK_SANITY_S = 6.0;        // beyond this, bending can't plausibly catch up — just cut
  let overHardStreak = 0;
  let touchTimer = null;
  let touching = false;

  function vinylTouch(drift) {
    touching = true;
    clearInterval(touchTimer);
    // average rate deviation needed to close `drift` seconds over TOUCH_S, for a
    // half-sine bump (whose average is peak * 2/pi over the half period)
    const needed = Math.abs(drift) * Math.PI / (2 * TOUCH_S);
    const peak = Math.sign(-drift) * Math.min(Math.max(needed, TOUCH_MIN_DEV), TOUCH_MAX_DEV);
    const t0 = performance.now();
    touchTimer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      if (t >= TOUCH_S || audio.paused) {
        audio.playbackRate = 1;
        touching = false;
        clearInterval(touchTimer);
        return;
      }
      audio.playbackRate = 1 + peak * Math.sin(Math.PI * t / TOUCH_S);
    }, 50);
  }

  function startDrift() {
    clearInterval(driftTimer);
    clearInterval(touchTimer);
    overHardStreak = 0;
    touching = false;
    driftTimer = setInterval(() => {
      if (audio.paused || !loopLen() || touching) return;
      const D = loopLen();
      let drift = audio.currentTime - targetPos();      // + means we are ahead
      if (drift >  D / 2) drift -= D;                    // choose nearest across the loop seam
      if (drift < -D / 2) drift += D;

      if (Math.abs(drift) > HARD) {
        // require two consecutive over-threshold reads before acting — filters
        // one-off measurement glitches (e.g. a check landing right on the loop seam)
        if (++overHardStreak >= 2) {
          overHardStreak = 0;
          if (Math.abs(drift) > RESEEK_SANITY_S) { audio.currentTime = targetPos(); audio.playbackRate = 1; }
          else vinylTouch(drift);
        }
      } else {
        overHardStreak = 0;
        audio.playbackRate = Math.abs(drift) > SOFT
          ? 1 - Math.max(-RATE_CLAMP, Math.min(RATE_CLAMP, drift))
          : 1;
      }
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
