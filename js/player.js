/* Player client: connects to the host and renders the game from the
 * personalized state views the host sends. */

const Player = (() => {
  let peer = null;
  let conn = null;
  let view = null;
  let myName = null;
  let roomCode = null;
  let roleRevealed = false;
  let investigations = []; // {name, isMafia}
  let connected = false;
  let reconnectTimer = null;
  let local = false;               // true when this client is the host's own seat
  let mount = 'player-content';    // container the player view renders into
  let pillId = 'player-room-pill';

  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Host-as-player mode: no network — messages loop straight into the game
   * engine running on this same page. */
  function initLocal(name, sendToHost) {
    clearTimeout(reconnectTimer);
    local = true;
    mount = 'host-player-area';
    pillId = 'host-room-pill';
    myName = name;
    view = null;
    roleRevealed = false;
    investigations = [];
    connected = true;
    conn = { open: true, send: sendToHost };
  }

  function receiveLocal(msg) { handleMessage(msg); }

  function join(code, name) {
    local = false;
    mount = 'player-content';
    pillId = 'player-room-pill';
    roomCode = code.toUpperCase();
    myName = name;
    roleRevealed = false;
    investigations = [];
    sessionStorage.setItem('mafia-session', JSON.stringify({
      roomCode, name, playerId: getStoredPlayerId(),
    }));
    connect();
  }

  function getStoredPlayerId() {
    try {
      const s = JSON.parse(sessionStorage.getItem('mafia-session') || '{}');
      return s.roomCode === roomCode ? s.playerId || null : null;
    } catch (e) { return null; }
  }

  function saveSession(playerId) {
    sessionStorage.setItem('mafia-session', JSON.stringify({ roomCode, name: myName, playerId }));
  }

  function connect() {
    cleanup(false);
    renderStatus('Connecting to the game…');

    peer = new Peer(Object.assign({ debug: 1 }, window.MAFIA_PEER_CONFIG || {}));
    peer.on('open', () => {
      conn = peer.connect(Host.PEER_PREFIX + roomCode, { reliable: true });
      conn.on('open', () => {
        connected = true;
        conn.send({ t: 'join', name: myName, playerId: getStoredPlayerId() });
      });
      conn.on('data', handleMessage);
      conn.on('close', () => onLost());
      conn.on('error', () => onLost());
    });
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        fatal('No game found with room code ' + roomCode + '. Check the code and that the host is online.');
      } else if (!connected) {
        fatal('Connection failed (' + err.type + '). Check your internet connection and try again.');
      } else {
        onLost();
      }
    });
  }

  function onLost() {
    if (local || !peer) return;
    connected = false;
    render(); // show reconnect banner over last known state
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2500);
  }

  function cleanup(full) {
    clearTimeout(reconnectTimer);
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    connected = false;
    if (full) { view = null; sessionStorage.removeItem('mafia-session'); }
  }

  function fatal(msg) {
    if (local) return; // loopback errors can't occur; never bounce the host out
    cleanup(true);
    App.showJoinError(msg);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'joined') {
      if (!local) saveSession(msg.playerId);
      const pill = el(pillId);
      if (pill) pill.textContent = 'Room: ' + msg.roomCode;
    } else if (msg.t === 'state') {
      if (msg.view.phase === 'lobby' && (!view || view.phase !== 'lobby')) {
        // A new game is forming — clear leftovers from the previous one.
        investigations = [];
        roleRevealed = false;
      }
      view = msg.view;
      render();
    } else if (msg.t === 'investigation') {
      investigations.push(msg);
      render();
    } else if (msg.t === 'error') {
      if (msg.fatal) fatal(msg.msg);
    }
  }

  function sendAction(msg) { if (conn && conn.open) conn.send(msg); }

  /* ---------------- rendering ---------------- */

  function renderStatus(text) {
    const c = el(mount);
    if (c) c.innerHTML = `<div class="card center"><p class="pulsing">${esc(text)}</p></div>`;
  }

  function roleCardHTML(roleId, concealable) {
    const r = ROLES[roleId];
    if (concealable && !roleRevealed) {
      return `<div id="role-card" class="role-card concealed">
        <div class="role-icon">🎭</div>
        <div class="role-name">Your secret role</div>
        <div class="role-desc">Tap to reveal — make sure no one is looking!</div>
      </div>`;
    }
    return `<div id="role-card" class="role-card">
      <div class="role-icon">${r.icon}</div>
      <div class="role-name">${r.name}</div>
      <div class="role-team ${r.team}">Team ${r.team === 'mafia' ? 'Mafia' : 'Town'}</div>
      <div class="role-desc">${r.desc}</div>
      ${concealable ? '<div class="hint">Tap to hide</div>' : ''}
    </div>`;
  }

  function playersListHTML(withVotes) {
    const counts = (view.vote && view.vote.counts) || {};
    return `<div class="card"><h3>Players</h3><div class="player-list">${
      view.players.map(p => {
        const role = p.role ? `<span class="role-tag ${ROLES[p.role].team}">${ROLES[p.role].icon} ${ROLES[p.role].name}</span>` : '';
        const votes = withVotes && counts[p.id] ? `<span class="vote-count">${counts[p.id]} 🗳</span>` : '';
        const dead = !p.alive ? `<span class="status">${p.causeOfDeath === 'vote' ? 'voted out' : 'killed'}</span>` : '';
        return `<div class="player-row ${p.alive ? '' : 'dead'}">
          <span class="dot ${p.connected ? 'on' : 'off'}"></span>
          <span class="name">${esc(p.name)}${p.id === view.you.id ? ' (you)' : ''}</span>
          ${role}${votes}${dead}</div>`;
      }).join('')
    }</div></div>`;
  }

  function announceHTML() {
    const a = view.announce;
    if (!a) return '';
    if (view.phase === 'day' && a.kind === 'dawn') {
      if (a.killedName) {
        return `<div class="banner death"><span class="big-emoji">💀</span>
          <p><strong>${esc(a.killedName)}</strong> was killed in the night.<br>
          They were the <strong>${ROLES[a.killedRole].name}</strong>.</p></div>`;
      }
      return `<div class="banner day"><span class="big-emoji">${a.saved ? '💉' : '🌤'}</span>
        <p>${a.saved ? 'The mafia struck, but the doctor saved their target — no one died!' : 'No one died in the night.'}</p></div>`;
    }
    if (view.phase === 'night' && a.kind === 'verdict' && view.dayNum > 1) {
      if (a.eliminatedName) {
        return `<div class="banner death"><p>The town voted out <strong>${esc(a.eliminatedName)}</strong> —
          they were the <strong>${ROLES[a.eliminatedRole].name}</strong>.</p></div>`;
      }
      return `<div class="banner day"><p>${a.tied ? 'The vote was tied — no one was eliminated.' : 'The town chose to eliminate no one.'}</p></div>`;
    }
    return '';
  }

  function investigationsHTML() {
    if (!investigations.length || !view.you.alive || view.you.role !== 'detective') return '';
    return `<div class="card"><h3>🔍 Your investigations</h3><div class="log">${
      investigations.map(i => `<div class="entry ${i.isMafia ? 'important' : ''}">${esc(i.name)} is ${i.isMafia ? 'MAFIA 🔪' : 'not mafia ✅'}</div>`).join('')
    }</div></div>`;
  }

  function render() {
    if (!view) { renderStatus('Connecting to the game…'); return; }
    const c = el(mount);
    if (!c) return;
    let html = '';

    if (!connected) {
      html += `<div class="banner death pulsing"><p>⚠️ Connection lost — trying to reconnect…</p></div>`;
    }

    /* ----- lobby ----- */
    if (view.phase === 'lobby') {
      html += `<div class="banner night"><span class="big-emoji">🛋</span>
        <h2>You're in, ${esc(view.you.name)}!</h2>
        <p class="muted">${local ? 'Share the room code — start the game below once everyone has joined.' : 'Waiting for the host to start the game.'}</p>
        ${view.roleSummary ? `<p class="muted small-text">Roles in play: ${esc(view.roleSummary)}</p>` : ''}</div>`;
      html += playersListHTML(false);
    }

    /* ----- dead spectator ----- */
    else if (view.phase !== 'ended' && !view.you.alive) {
      html += `<div class="banner death"><span class="big-emoji">👻</span>
        <h2>You are dead</h2>
        <p class="muted">You were the ${ROLES[view.you.role].name}. Sit back and watch — but don't give anything away!</p></div>`;
      html += announceHTML();
      html += playersListHTML(view.phase === 'day');
    }

    /* ----- night ----- */
    else if (view.phase === 'night') {
      html += announceHTML();
      html += `<div class="banner night"><span class="big-emoji">🌙</span><h2>Night ${view.dayNum}</h2></div>`;
      html += roleCardHTML(view.you.role, true);

      const n = view.night;
      if (n.mates && n.mates.length) {
        html += `<div class="card"><h3>🔪 Your fellow mafia</h3><p>${n.mates.map(esc).join(', ')}</p></div>`;
      }
      html += investigationsHTML();

      if (!n.prompt) {
        html += `<div class="card center"><p class="pulsing">😴 You sleep soundly. Waiting for the night to end…</p></div>`;
      } else if (n.acted) {
        html += `<div class="card center"><p>✅ You chose <strong>${esc(n.actionTarget)}</strong>.</p>
          <p class="muted pulsing small-text">Waiting for ${n.waitingOn} more…</p></div>`;
      } else {
        html += `<div class="card"><h3>${esc(n.prompt)}</h3><div class="target-grid">${
          n.targets.map(t => `<button class="btn" data-night="${t.id}">${esc(t.name)}</button>`).join('')
        }</div></div>`;
      }
    }

    /* ----- day / voting ----- */
    else if (view.phase === 'day') {
      html += `<div class="banner day"><span class="big-emoji">☀️</span><h2>Day ${view.dayNum}</h2></div>`;
      html += announceHTML();
      html += roleCardHTML(view.you.role, true);
      html += investigationsHTML();

      const v = view.vote;
      html += `<div class="card">
        <div class="section-title"><h3>Vote to eliminate</h3>
        <span class="muted small-text">${v.voted}/${v.needed} voted</span></div>
        <p class="muted small-text" style="margin-bottom:10px">Discuss out loud, then cast your vote. You can change it until everyone has voted.</p>
        <div class="target-grid">${
          v.targets.map(t => `<button class="btn ${v.yourVote === t.id ? 'selected' : ''}" data-vote="${t.id}">
            <span>${esc(t.name)}</span>${v.counts[t.id] ? `<span class="vote-count">${v.counts[t.id]} 🗳</span>` : ''}</button>`).join('')
        }<button class="btn ${v.yourVote === 'nobody' ? 'selected' : ''}" data-vote="nobody">
          <span>🕊 No one</span>${v.counts.nobody ? `<span class="vote-count">${v.counts.nobody} 🗳</span>` : ''}</button>
        </div></div>`;
      html += playersListHTML(true);
    }

    /* ----- game over ----- */
    else if (view.phase === 'ended') {
      const won = (view.winner === 'mafia') === (ROLES[view.you.role].team === 'mafia');
      html += `<div class="banner win"><span class="big-emoji">${view.winner === 'town' ? '🎉' : '🔪'}</span>
        <h2>${view.winner === 'town' ? 'The town wins!' : 'The mafia win!'}</h2>
        <p>${won ? 'Your team won! 🏆' : 'Your team lost this time.'}
        You were the <strong>${ROLES[view.you.role].name}</strong>.</p>
        <p class="muted small-text">If the host starts a new game, you'll join it automatically.</p></div>`;
      html += playersListHTML(false);
    }

    c.innerHTML = html;

    const roleCard = el('role-card');
    if (roleCard && view.phase !== 'ended') {
      roleCard.onclick = () => { roleRevealed = !roleRevealed; render(); };
    }
    c.querySelectorAll('[data-night]').forEach(b => {
      b.onclick = () => sendAction({ t: 'night', target: b.dataset.night });
    });
    c.querySelectorAll('[data-vote]').forEach(b => {
      b.onclick = () => sendAction({ t: 'vote', target: b.dataset.vote });
    });
  }

  /* Resume a session after a page refresh, if one exists. */
  function tryResume() {
    try {
      const s = JSON.parse(sessionStorage.getItem('mafia-session') || 'null');
      if (s && s.roomCode && s.name) {
        App.showScreen('player');
        el('player-room-pill').textContent = 'Room: ' + s.roomCode;
        join(s.roomCode, s.name);
        return true;
      }
    } catch (e) {}
    return false;
  }

  return { join, cleanup, tryResume, initLocal, receiveLocal };
})();
