/* App shell: screen routing and landing-page wiring. */

const App = (() => {
  const el = id => document.getElementById(id);

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
    el('btn-go-host').onclick = () => {
      showScreen('host');
      Host.create();
    };

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

  return { showScreen, showJoinError };
})();
