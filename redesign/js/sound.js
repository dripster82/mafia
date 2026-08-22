/* Small WebAudio chimes — no audio assets needed. iOS unlocks audio on the
 * first user tap (see main.js). Mute preference persists per device. */

const Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('mafia-muted') === '1'; } catch (e) {}

  function ensure() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) { /* no audio available */ }
  }

  function tone(freq, at, dur, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t0 = ctx.currentTime + at;
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol || 0.1, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function play(kind) {
    if (muted) return;
    ensure();
    if (!ctx || ctx.state !== 'running') return;
    try {
      if (kind === 'night') { tone(392, 0, 0.4); tone(262, 0.2, 0.55); }
      else if (kind === 'day') { tone(523, 0, 0.3); tone(659, 0.16, 0.42); }
      else if (kind === 'turn') { tone(880, 0, 0.14, 0.08); tone(1174, 0.16, 0.2, 0.08); }
      else if (kind === 'win') { tone(523, 0, 0.18); tone(659, 0.16, 0.18); tone(784, 0.32, 0.4); }
      else if (kind === 'danger') { tone(311, 0, 0.25, 0.12); tone(233, 0.22, 0.5, 0.12); }
      else if (kind === 'tick') { tone(196, 0, 0.07, 0.05); }
    } catch (e) {}
  }

  function toggle() {
    muted = !muted;
    try { localStorage.setItem('mafia-muted', muted ? '1' : '0'); } catch (e) {}
    if (!muted) { ensure(); play('turn'); }
    return muted;
  }

  return { play, toggle, ensure, isMuted: () => muted };
})();
