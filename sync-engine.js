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

  // --- gentle convergence: nudge playbackRate, hard re-seek only on big gaps ---
  const SOFT = 0.030, HARD = 0.250;  // seconds
  function startDrift() {
    clearInterval(driftTimer);
    driftTimer = setInterval(() => {
      if (audio.paused || !loopLen()) return;
      const D = loopLen();
      let drift = audio.currentTime - targetPos();      // + means we are ahead
      if (drift >  D / 2) drift -= D;                    // choose nearest across the loop seam
      if (drift < -D / 2) drift += D;
      if (Math.abs(drift) > HARD)      { audio.currentTime = targetPos(); audio.playbackRate = 1; }
      else if (Math.abs(drift) > SOFT) { audio.playbackRate = 1 - Math.max(-0.03, Math.min(0.03, drift)); }
      else                             { audio.playbackRate = 1; }
    }, 2000);
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
