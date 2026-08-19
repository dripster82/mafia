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
      showScreen('host');
      Host.create(name);
    }
    el('btn-create-game').onclick = doCreate;
    el('host-name').addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });

    el('btn-go-join').onclick = () => {
      el('join-error').classList.add('hidden');
      showScreen('join');
      el('join-code').focus();
    };

    document.querySelectorAll('.back-home').forEach(b => {
      b.onclick = () => showScreen('home');
    });

    el('btn-join').onclick = doJoin;
    el('join-name').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
    el('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') el('join-name').focus(); });

    function doJoin() {
      const code = el('join-code').value.trim().toUpperCase();
      const name = el('join-name').value.trim();
      const err = el('join-error');
      if (code.length !== 5) { err.textContent = 'Room codes are 5 letters.'; err.classList.remove('hidden'); return; }
      if (!name) { err.textContent = 'Please enter your name.'; err.classList.remove('hidden'); return; }
      err.classList.add('hidden');
      showScreen('player');
      el('player-room-pill').textContent = 'Room: ' + code;
      Player.join(code, name);
    }

    // Support ?join=CODE links and refresh-resume.
    const params = new URLSearchParams(location.search);
    const codeParam = (params.get('join') || '').toUpperCase();
    if (!Player.tryResume() && codeParam) {
      showScreen('join');
      el('join-code').value = codeParam;
      el('join-name').focus();
    }

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
