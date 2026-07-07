/*
  sync-engine.js — synchronized, lock-screen-safe looping playback
  ------------------------------------------------------------------
  Model: pre-recorded file, downloaded once, looped locally, its phase
  locked to a shared clock so every device plays the same moment.

  WHY <audio> AND NOT WEB AUDIO: a media element keeps playing when the
  phone locks; AudioContext gets suspended. The cost is that we can only
  SEEK (currentTime), so realistic cross-device sync is ~20–50 ms, not
  sample-accurate. That is the deliberate trade for background playback.

  WIRING (your existing button):
      import { createPlayer } from './sync-engine.js';
      const player = createPlayer({
        channels: [ 'https://audio.you.org/ch1.aac', ... 8 urls ... ],
        duration: 612.0,                       // EXACT loop length in seconds
        timeUrl:  'https://audio.you.org/time', // omit to trust device clocks
        title:    'Installation Title',
      });
      document.getElementById('playBtn')
              .addEventListener('click', () => player.toggle());
*/

export function createPlayer({ channels, duration = null, timeUrl = null, title = 'Installation' }) {
  // --- pick this visitor's channel from ?ch=N (1-based); bare link falls back to random ---
  const chParam = new URLSearchParams(location.search).get('ch');
  const n = chParam ? Math.min(Math.max(parseInt(chParam, 10), 1), channels.length)
                     : 1 + Math.floor(Math.random() * channels.length);
  const url = channels[n - 1];

  const audio = new Audio();
  audio.src = url;
  audio.loop = true;                 // loop locally — no network during playback
  audio.preload = 'auto';            // fully buffer so seeking + locked playback are solid
  audio.setAttribute('playsinline', ''); // iOS: never go fullscreen
  // NOTE: do NOT set crossOrigin — plain playback across origins needs no CORS.

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
    audio,   // exposed if you want to reflect state on your button
  };
}
