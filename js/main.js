/* App shell: screen routing and landing-page wiring. */

const App = (() => {
  const el = id => document.getElementById(id);

  /* Pretty invite link, e.g. https://user.github.io/mafia/QWXZR.
   * 404.html turns that path back into ?join=QWXZR on GitHub Pages. */
  function joinLinkFor(code) {
    let base = location.origin + location.pathname.replace(/index\.html$/, '');
    if (!base.endsWith('/')) base += '/';
    return base + code;
  }

  /* SVG QR code for the invite link, on a white tile so cameras can read it. */
  function qrSvgFor(code) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(joinLinkFor(code));
      qr.make();
      return `<div class="qr-box">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>`;
    } catch (e) {
      return '';
    }
  }

  const escText = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- Public game directory (see LOBBY_URL in roles.js) ---- */

  let publicPoll = null;

  async function loadPublicGames() {
    const box = el('public-games');
    if (!box) return;
    try {
      const res = await fetch(LOBBY_URL + '/json?poll=1&since=90s', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const text = await res.text();
      // Newline-delimited ntfy events; each message is one lobby announcement.
      // Everything in it is untrusted public input — validate and escape.
      const rooms = {};
      text.split('\n').forEach(line => {
        try {
          const ev = JSON.parse(line);
          if (ev.event && ev.event !== 'message') return;
          const r = JSON.parse(ev.message);
          if (!r || !/^[A-Z0-9]{5}$/.test(String(r.code || ''))) return;
          if (!rooms[r.code] || (r.ts || 0) >= (rooms[r.code].ts || 0)) rooms[r.code] = r;
        } catch (e) {}
      });
      const list = Object.values(rooms).filter(r => !r.closed)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 10);
      box.innerHTML = list.length
        ? list.map(r => {
            const bots = Math.max(0, parseInt(r.bots, 10) || 0);
            const names = (Array.isArray(r.names) ? r.names : []).slice(0, 8)
              .map(n => escText(String(n).slice(0, 20)));
            const who = `${names.join(', ') || 'waiting for players'}${bots ? ` · 🤖×${bots}` : ''}`;
            return `<button class="btn vote-line public-room" data-code="${r.code}">
              <span class="vote-voters">${who}</span>
              <span class="vote-target">${escText(String(r.host || 'Someone').slice(0, 16))}’s game · <strong>${r.code}</strong></span>
            </button>`;
          }).join('')
        : '<p class="muted small-text">No public games right now. Host one and tick “🌐 Public game” — or join a private game with its code.</p>';
      box.querySelectorAll('[data-code]').forEach(b => {
        b.onclick = () => {
          el('join-code').value = b.dataset.code;
          const n = el('join-name');
          if (n.value.trim()) el('btn-join').focus(); else n.focus();
        };
      });
    } catch (e) {
      box.innerHTML = '<p class="muted small-text">Couldn’t reach the public game directory — join with a room code instead.</p>';
    }
  }

  function watchPublicGames() {
    loadPublicGames();
    clearInterval(publicPoll);
    publicPoll = setInterval(() => {
      if (!el('screen-join').classList.contains('active')) { clearInterval(publicPoll); return; }
      loadPublicGames();
    }, 15000);
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el('screen-' + name).classList.add('active');
  }

  function showJoinError(msg) {
    showScreen('join');
    const e = el('join-error');
    e.textContent = msg;
    e.classList.remove('hidden');
  }

  function init() {
    // The deploy workflow stamps __BUILD__ with the commit; locally it stays
    // unreplaced, so show "dev" instead.
    const ver = el('app-version');
    if (ver && ver.textContent.includes('__BUILD__')) ver.textContent = 'Version dev';

    // Apply any non-English strings to the shell screens (see js/i18n.js).
    if (typeof I18N !== 'undefined' && I18N.lang !== 'en') I18N.apply();

    // A one-line record for returning players (kept per device).
    try {
      const s = JSON.parse(localStorage.getItem('mafia-stats') || 'null');
      if (s && s.games) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = `📈 Your record: ${s.games} game${s.games > 1 ? 's' : ''}, ${s.wins || 0} won`;
        el('app-version').before(p);
      }
    } catch (e) {}

    // A host that reloaded mid-game can pick the same room back up.
    const snap = typeof Host !== 'undefined' && Host.snapshotInfo && Host.snapshotInfo();
    if (snap) {
      const b = document.createElement('button');
      b.className = 'btn big';
      b.id = 'btn-resume-game';
      b.textContent = `▶ Resume game ${snap.roomCode} (${snap.phase} ${snap.dayNum || ''})`.trim();
      el('btn-go-host').after(b);
      b.onclick = () => {
        showScreen('host');
        if (!Host.resume()) { showScreen('home'); b.remove(); }
      };
    }

    // Remember the player's name between games.
    let savedName = '';
    try { savedName = localStorage.getItem('mafia-name') || ''; } catch (e) {}
    if (savedName) { el('host-name').value = savedName; el('join-name').value = savedName; }
    const rememberName = n => { try { localStorage.setItem('mafia-name', n); } catch (e) {} };

    el('btn-go-host').onclick = () => {
      el('host-error').classList.add('hidden');
      showScreen('host-setup');
      el('host-name').focus();
    };

    function doCreate() {
      const name = el('host-name').value.trim();
      if (!name) {
        el('host-error').textContent = 'Please enter your name.';
        el('host-error').classList.remove('hidden');
        return;
      }
      rememberName(name);
      showScreen('host');
      Host.create(name);
    }
    el('btn-create-game').onclick = doCreate;
    el('host-name').addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });

    el('btn-go-join').onclick = () => {
      el('join-error').classList.add('hidden');
      showScreen('join');
      watchPublicGames();
      el('join-name').focus();
    };
    el('btn-refresh-public').onclick = async () => {
      const b = el('btn-refresh-public');
      b.disabled = true;
      b.textContent = '⏳ Checking…';
      const started = Date.now();
      await loadPublicGames();
      // Hold the spinner a beat so instant responses still visibly "did something".
      setTimeout(() => {
        b.textContent = '✓ Updated';
        setTimeout(() => { b.textContent = '↻ Refresh'; b.disabled = false; }, 900);
      }, Math.max(0, 400 - (Date.now() - started)));
    };

    document.querySelectorAll('.back-home').forEach(b => {
      b.onclick = () => showScreen('home');
    });

    el('btn-join').onclick = doJoin;
    el('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') el('join-code').focus(); });
    el('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

    function doJoin() {
      const code = el('join-code').value.trim().toUpperCase();
      const name = el('join-name').value.trim();
      const err = el('join-error');
      if (code.length !== 5) { err.textContent = 'Room codes are 5 letters.'; err.classList.remove('hidden'); return; }
      if (!name) { err.textContent = 'Please enter your name.'; err.classList.remove('hidden'); return; }
      err.classList.add('hidden');
      rememberName(name);
      showScreen('player');
      el('player-room-pill').textContent = 'Room: ' + code;
      Player.join(code, name);
    }

    // Support ?join=CODE links and refresh-resume. A join link for a
    // DIFFERENT room always beats resuming an old session — otherwise a tab
    // with a stale session would silently reconnect to the previous room.
    const params = new URLSearchParams(location.search);
    const codeParam = (params.get('join') || '').toUpperCase();
    let stored = null;
    try { stored = JSON.parse(sessionStorage.getItem('mafia-session')); } catch (e) {}
    if (codeParam && (!stored || stored.roomCode !== codeParam)) {
      sessionStorage.removeItem('mafia-session');
      showScreen('join');
      watchPublicGames();
      el('join-code').value = codeParam;
      el('join-name').focus();
    } else if (!Player.tryResume() && codeParam) {
      showScreen('join');
      watchPublicGames();
      el('join-code').value = codeParam;
      el('join-name').focus();
    }

    // Sound: unlock audio on the first tap (iOS requires a user gesture),
    // and wire the mute toggles.
    document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });
    const muteButtons = document.querySelectorAll('.btn-mute');
    const syncMute = () => muteButtons.forEach(b => { b.textContent = Sound.isMuted() ? '🔇' : '🔊'; });
    muteButtons.forEach(b => { b.onclick = () => { Sound.toggle(); syncMute(); }; });
    syncMute();

    // Warn the host before accidentally leaving mid-game.
    window.addEventListener('beforeunload', e => {
      if (el('screen-host').classList.contains('active')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showScreen, showJoinError, joinLinkFor, qrSvgFor };
})();
