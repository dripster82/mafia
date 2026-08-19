/* Player client: connects to the host and renders the game from the
 * personalized state views the host sends. */

const Player = (() => {
  let peer = null;
  let conn = null;
  let view = null;
  let myName = null;
  let roomCode = null;
  let roleRevealed = false;
  let intel = []; // private dawn reports (investigations, sightings, ledger…)
  let connected = false;
  let reconnectTimer = null;
  let connectTimer = null;
  let reconnectAttempts = 0;
  let local = false;               // true when this client is the host's own seat
  let mount = 'player-content';    // container the player view renders into
  let pillId = 'player-room-pill';
  let nameDraft = null;            // in-progress lobby rename, survives re-renders
  let toastMsg = null;             // transient message from the host (e.g. name taken)
  let toastTimer = null;
  let chatDraft = '';              // in-progress chat message, survives re-renders
  let phaseTickInterval = null;    // 1s countdown updater for the phase timer
  let lastTurnKey = null;          // chime once when it's your turn to act

  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- join diagnostics ---------------- */

  let dlog = [];
  let lastLoggedPhase = null;

  function dbg(msg) {
    const t = new Date().toISOString().slice(11, 23);
    dlog.push(`[${t}] ${msg}`);
    if (dlog.length > 300) dlog.shift();
    const box = document.getElementById('debug-log');
    if (box) { box.textContent = dlog.join('\n'); box.scrollTop = box.scrollHeight; }
  }

  function debugHeader() {
    const ver = (document.getElementById('app-version') || {}).textContent || '?';
    return [
      `Mafia Night join debug — ${new Date().toISOString()}`,
      `${ver} | ${location.href}`,
      `UA: ${navigator.userAgent}`,
      `online: ${navigator.onLine}`,
      '',
    ].join('\n');
  }

  function debugPanelHTML() {
    return `<div class="card">
      <div class="section-title"><h3>🔧 Debug log</h3>
        <button id="btn-copy-debug" class="btn small">Copy</button></div>
      <pre id="debug-log" class="debug-log">${esc(dlog.join('\n'))}</pre>
    </div>`;
  }

  function wireDebugPanel() {
    const cp = el('btn-copy-debug');
    if (cp) cp.onclick = () => {
      const text = debugHeader() + dlog.join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => { cp.textContent = 'Copied!'; setTimeout(() => { cp.textContent = 'Copy'; }, 1500); })
        .catch(() => { prompt('Copy the debug log:', text); });
    };
    const box = el('debug-log');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* Gather ICE candidates against our own server config to learn which
   * paths this device can use: host (LAN), srflx (STUN), relay (TURN). */
  function probeIce() {
    try {
      const cfg = (window.MAFIA_PEER_CONFIG && window.MAFIA_PEER_CONFIG.config) || PEER_OPTS.config;
      const pc = new RTCPeerConnection(cfg);
      const found = new Set();
      pc.createDataChannel('probe');
      pc.addEventListener('icecandidateerror', e =>
        dbg(`ice probe server error: ${e.url || '?'} code=${e.errorCode || '?'} ${e.errorText || ''}`));
      pc.onicecandidate = e => {
        if (e.candidate) {
          const m = / typ (\w+)/.exec(e.candidate.candidate);
          if (m && !found.has(m[1])) { found.add(m[1]); dbg(`ice probe: found ${m[1]} candidate`); }
        } else {
          dbg(`ice probe complete: ${found.size ? [...found].join(', ') : 'NO candidates'}${found.has('relay') ? '' : ' — TURN relay NOT reachable'}`);
          try { pc.close(); } catch (err) {}
        }
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => dbg('ice probe offer failed: ' + e.message));
      setTimeout(() => { try { pc.close(); } catch (err) {} }, 20000);
    } catch (e) {
      dbg('ice probe unavailable: ' + e.message);
    }
  }

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
    intel = [];
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
    intel = [];
    dlog = [];
    dbg(`join requested: room=${roomCode} name=${name}`);
    dbg(`online=${navigator.onLine} secure=${location.protocol === 'https:'}`);
    probeIce();
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

    // If the data channel can't be established (blocked network, NAT the
    // relay can't cross), fail with a clear message instead of spinning.
    clearTimeout(connectTimer);
    connectTimer = setTimeout(() => {
      if (!connected && !view) {
        dbg('TIMEOUT: no data channel after 20s');
        connFail('Couldn’t reach the host after 20 seconds. Make sure both devices are online, then try again.');
      }
    }, 20000);

    const opts = Object.assign({}, PEER_OPTS, window.MAFIA_PEER_CONFIG || {});
    dbg(`creating peer (broker: ${opts.host || '0.peerjs.com (PeerJS cloud)'})`);
    peer = new Peer(opts);
    peer.on('open', id => {
      dbg(`broker connected, our peer id: ${id}`);
      dbg(`dialing host: ${Host.PEER_PREFIX + roomCode}`);
      conn = peer.connect(Host.PEER_PREFIX + roomCode, { reliable: true });
      conn.on('open', () => {
        dbg('data channel OPEN — sending join');
        connected = true;
        conn.send({ t: 'join', name: myName, playerId: getStoredPlayerId() });
      });
      conn.on('iceStateChanged', s => dbg('ice state: ' + s));
      conn.on('data', handleMessage);
      conn.on('close', () => { dbg('data channel closed'); onLost(); });
      conn.on('error', e => { dbg('conn error: ' + (e && (e.type || e.message) || e)); onLost(); });
      // Watch the underlying RTCPeerConnection once negotiation begins.
      setTimeout(() => {
        const pc = conn && conn.peerConnection;
        if (!pc) { dbg('no RTCPeerConnection yet (no answer from host?)'); return; }
        dbg(`pc states: conn=${pc.connectionState} ice=${pc.iceConnectionState} gathering=${pc.iceGatheringState} signaling=${pc.signalingState}`);
        pc.addEventListener('connectionstatechange', () => dbg('pc connection: ' + pc.connectionState));
        pc.addEventListener('icegatheringstatechange', () => dbg('pc gathering: ' + pc.iceGatheringState));
        pc.addEventListener('signalingstatechange', () => dbg('pc signaling: ' + pc.signalingState));
        pc.addEventListener('icecandidateerror', e =>
          dbg(`ice server error: ${e.url || '?'} code=${e.errorCode || '?'} ${e.errorText || ''}`));
        pc.addEventListener('icecandidate', e => {
          if (e.candidate) {
            const m = / typ (\w+)/.exec(e.candidate.candidate);
            if (m) dbg('local candidate: ' + m[1]);
          } else dbg('local gathering complete');
        });
      }, 2000);
    });
    peer.on('disconnected', () => {
      if (!peer || peer.destroyed) return;
      dbg('lost broker connection, reconnecting to broker…');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', err => {
      dbg(`peer error: ${err.type} — ${err.message || ''}`);
      if (err.type === 'peer-unavailable') {
        connFail('No game found with room code ' + roomCode + '. Check the code and that the host has the game open right now.');
      } else if (!connected) {
        connFail('Connection failed (' + err.type + '). Check your internet connection and try again.');
      } else {
        onLost();
      }
    });
  }

  function onLost() {
    if (local || !peer) return;
    connected = false;
    reconnectAttempts++;
    dbg('connection lost — retrying in 2.5s');
    render(); // show reconnect banner over last known state
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2500);
  }

  function cleanup(full) {
    clearTimeout(reconnectTimer);
    clearTimeout(connectTimer);
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

  /* Connection-level failure: stay on this screen with the debug log and a
   * retry button, instead of bouncing back to the join form. */
  function connFail(msg) {
    if (local) return;
    dbg('FAILED: ' + msg);
    cleanup(false);
    const c = el(mount);
    if (!c) return;
    c.innerHTML = `<div class="card center">
        <p class="error">${esc(msg)}</p>
        <button id="btn-retry" class="btn primary big">Try again</button>
        <button id="btn-give-up" class="btn link">← Back to join screen</button>
      </div>` + debugPanelHTML();
    const r = el('btn-retry');
    if (r) r.onclick = () => { dbg('--- retry ---'); connect(); };
    const g = el('btn-give-up');
    if (g) g.onclick = () => { cleanup(true); App.showScreen('join'); };
    wireDebugPanel();
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'joined') {
      reconnectAttempts = 0;
      if (!local) { dbg(`JOINED game as player ${msg.playerId}`); saveSession(msg.playerId); }
      const pill = el(pillId);
      if (pill) pill.textContent = 'Room: ' + msg.roomCode;
    } else if (msg.t === 'state') {
      if (!local && msg.view.phase !== lastLoggedPhase) {
        lastLoggedPhase = msg.view.phase;
        dbg(`state received: phase=${msg.view.phase} players=${msg.view.players.length}`);
      }
      if (msg.view.phase === 'lobby' && (!view || view.phase !== 'lobby')) {
        // A new game is forming — clear leftovers from the previous one.
        intel = [];
        roleRevealed = false;
      }
      const prevPhase = view ? view.phase : null;
      view = msg.view;
      if (nameDraft !== null && view.you.name === nameDraft.trim()) nameDraft = null;
      maybeAnimatePhase(prevPhase, view.phase, view.dayNum);
      // A soft cue the first time each night that YOU have an action pending.
      if (view.phase === 'night' && view.night && view.night.prompt && !view.night.acted) {
        const key = 'night' + view.dayNum;
        if (key !== lastTurnKey) { lastTurnKey = key; if (prevPhase !== null) Sound.play('turn'); }
      }
      render();
    } else if (msg.t === 'toast') {
      toastMsg = msg.msg;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastMsg = null; render(); }, 4000);
      render();
    } else if (msg.t === 'report') {
      intel.push(msg.line);
      if (intel.length > 40) intel.shift();
      render();
    } else if (msg.t === 'error') {
      if (msg.fatal) fatal(msg.msg);
    }
  }

  function sendAction(msg) { if (conn && conn.open) conn.send(msg); }

  /* ---------------- day/night transition animation ---------------- */

  function maybeAnimatePhase(prevPhase, phase, dayNum) {
    if (prevPhase === null || prevPhase === phase) return;
    let kind = null;
    if (phase === 'night' && (prevPhase === 'reveal' || prevPhase === 'day' || prevPhase === 'verdict')) kind = 'night';
    if (phase === 'day' && prevPhase === 'night') kind = 'day';
    if (phase === 'ended') Sound.play('win');
    if (!kind || document.querySelector('.phase-overlay')) return;
    Sound.play(kind);
    const ov = document.createElement('div');
    ov.className = 'phase-overlay to-' + kind;
    ov.innerHTML = `
      <span class="orb setting">${kind === 'night' ? '☀️' : '🌙'}</span>
      <span class="orb rising">${kind === 'night' ? '🌙' : '☀️'}</span>
      <div class="phase-label">${kind === 'night' ? 'Night' : 'Day'} ${dayNum}</div>`;
    document.body.appendChild(ov);
    setTimeout(() => ov.remove(), 2400);
  }

  /* ---------------- rendering ---------------- */

  function renderStatus(text) {
    const c = el(mount);
    if (!c) return;
    // While connecting (never in local/host mode), show the live debug log.
    const showDebug = !local && !view;
    c.innerHTML = `<div class="card center"><p class="pulsing">${esc(text)}</p></div>`
      + (showDebug ? debugPanelHTML() : '');
    if (showDebug) wireDebugPanel();
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
    const info = (view && view.you.info) || [];
    return `<div id="role-card" class="role-card team-${r.team}">
      <div class="role-icon">${r.icon}</div>
      <div class="role-name">${r.name}</div>
      <div class="role-team ${r.team}">${r.team === 'mafia' ? 'Team Mafia' : r.team === 'jester' ? 'Neutral — wins alone' : 'Team Town'}</div>
      <div class="role-desc">${r.desc}</div>
      ${info.map(i => `<div class="role-desc" style="margin-top:6px"><strong>${esc(i)}</strong></div>`).join('')}
      ${concealable ? '<div class="hint">Tap to hide</div>' : ''}
    </div>`;
  }

  function playersListHTML(withVotes) {
    const counts = (view.vote && view.vote.counts) || {};
    return `<div class="card"><h3>Players</h3><div class="player-list">${
      view.players.map(p => {
        const role = p.role ? `<span class="role-tag ${ROLES[p.role].team}">${ROLES[p.role].icon} ${ROLES[p.role].name}</span>` : '';
        const votes = withVotes && counts[p.id] ? `<span class="vote-count">${counts[p.id]} 🗳</span>` : '';
        const deadLabel = { vote: 'voted out', vigilante: 'shot', poison: 'poisoned', guard: 'died guarding' };
        const dead = !p.alive
          ? `<span class="status">${p.spectator ? '👁 spectating' : deadLabel[p.causeOfDeath] || 'killed'}</span>` : '';
        const mayorBadge = p.pledged && p.alive ? '<span class="status">🎖 Mayor</span>' : '';
        return `<div class="player-row ${p.alive ? '' : 'dead'}">
          ${p.alive ? `<span class="dot ${p.connected ? 'on' : 'off'}"></span>` : p.spectator ? '<span class="skull">👁</span>' : '<span class="skull">💀</span>'}
          <span class="name">${p.avatar || ''} ${esc(p.name)}${p.id === view.you.id ? ' (you)' : ''}</span>
          ${mayorBadge}${role}${votes}${dead}</div>`;
      }).join('')
    }</div></div>`;
  }

  /* Day-phase table talk. */
  function chatCardHTML() {
    if (!view.chat) return '';
    return `<div class="card"><h3>💬 Table talk</h3>
      <div id="chat-log" class="chat-log">${
        view.chat.length
          ? view.chat.map(m => `<div class="chat-msg"><span class="chat-who">${m.avatar || ''} ${esc(m.name)}</span> ${esc(m.text)}</div>`).join('')
          : '<p class="muted small-text">No one has said anything yet…</p>'
      }</div>
      ${view.canChat ? `<div class="chat-row">
        <input id="chat-input" type="text" maxlength="200" placeholder="Say something…" autocomplete="off" value="${esc(chatDraft)}">
        <button id="chat-send" class="btn">Send</button>
      </div>` : '<p class="muted small-text">The dead may listen, but not speak.</p>'}
    </div>`;
  }

  /* Lobby-only: rename yourself and pick an avatar. */
  function profileCardHTML() {
    const av = view.you.avatar;
    return `<div class="card"><h3>Your profile</h3>
      <div class="profile-row">
        <input id="profile-name" type="text" maxlength="16" autocomplete="off"
          value="${esc(nameDraft !== null ? nameDraft : view.you.name)}">
        <button id="profile-save" class="btn">Save</button>
      </div>
      ${toastMsg ? `<p class="error small-text" style="margin-top:6px">${esc(toastMsg)}</p>` : ''}
      <div class="avatar-grid">${AVATARS.map(a =>
        `<button class="avatar-btn ${a === av ? 'selected' : ''}" data-avatar="${a}">${a}</button>`).join('')}
      </div></div>`;
  }

  function announceHTML() {
    const a = view.announce;
    if (!a) return '';
    if (view.phase === 'day' && a.kind === 'dawn') {
      const parts = [];
      (a.killed || []).forEach(k => {
        const how = k.cause === 'vigilante' ? 'was shot' : k.cause === 'poison' ? 'succumbed to poison'
          : k.cause === 'guard' ? 'took a bullet meant for someone else' : 'was killed';
        parts.push(`<strong>${esc(k.name)}</strong> ${how} in the night — ${
          k.role ? `they were the <strong>${ROLES[k.role].icon} ${ROLES[k.role].name}</strong>.`
                 : 'their body was left unrecognisable. 🧹'}`);
      });
      if (a.woundedNames && a.woundedNames.length) parts.push(
        `<strong>${a.woundedNames.map(esc).join(' and ')}</strong> ${a.woundedNames.length > 1 ? 'were' : 'was'} wounded in the night — but survived!`);
      if (a.savedName) parts.push(`<strong>${esc(a.savedName)}</strong> was attacked, but the doctor saved them!`);
      else if (a.saved) parts.push('The doctor saved someone from an attack in the night!');
      if (a.revivedName) parts.push(`⚰️ A miracle — <strong>${esc(a.revivedName)}</strong> has risen from the dead!`);
      if (a.mayorName) parts.push(`📣 <strong>${esc(a.mayorName)}</strong> is the Mayor — proven village, and their vote now counts double.`);
      if (!parts.length) parts.push('No one died in the night.');
      const grim = (a.killed && a.killed.length) || (a.woundedNames && a.woundedNames.length);
      return `<div class="banner ${grim ? 'death' : 'day'}">
        <span class="big-emoji">${a.killed && a.killed.length ? '💀' : a.woundedNames && a.woundedNames.length ? '🩹' : a.saved ? '💉' : a.revivedName ? '⚰️' : '🌤'}</span>
        <p>${parts.join('</p><p>')}</p></div>`;
    }
    if (view.phase === 'night' && a.kind === 'verdict' && view.dayNum > 1) {
      if (a.eliminatedName) {
        return `<div class="banner death"><p>The village ganged up on <strong>${esc(a.eliminatedName)}</strong> —
          they were the <strong>${ROLES[a.eliminatedRole].name}</strong>.</p></div>`;
      }
      return `<div class="banner day"><p>${a.tied ? 'The vote was tied — no one was eliminated.'
        : a.noMajority ? 'No majority was reached — no one was eliminated.'
        : 'The village chose to eliminate no one.'}</p></div>`;
    }
    return '';
  }

  function intelHTML() {
    if (!intel.length || !view.you.alive) return '';
    return `<div class="card"><h3>🕵️ Your intel</h3><div class="log">${
      intel.map(line => `<div class="entry ${/MAFIA/.test(line) ? 'important' : ''}">${esc(line)}</div>`).join('')
    }</div></div>`;
  }

  function render() {
    if (!view) { renderStatus('Connecting to the game…'); return; }
    const c = el(mount);
    if (!c) return;
    let html = '';

    if (!connected) {
      html += `<div class="banner death pulsing"><p>⚠️ Connection lost — trying to reconnect…${
        reconnectAttempts > 3 ? '<br><span class="small-text muted">Still no luck — check the host’s screen is on with the game open.</span>' : ''
      }</p></div>`;
    }

    /* ----- lobby ----- */
    if (view.phase === 'lobby') {
      html += `<div class="banner night"><span class="big-emoji">🛋</span>
        <h2>You're in, ${esc(view.you.name)}!</h2>
        <p class="muted">${local ? 'Share the room code — start the game below once everyone has joined.' : 'Waiting for the host to start the game.'}</p>
        ${view.roleSummary ? `<p class="muted small-text">Roles in play: ${esc(view.roleSummary)}</p>` : ''}
        ${view.settings ? `<p class="muted small-text">First night: ${view.settings.safeFirstNight ? 'no deaths' : 'normal'} ·
          Mafia cap: ${view.settings.maxMafia || 'auto'} · Votes: ${view.settings.showVoters ? 'open' : 'secret ballot'}
          ${view.settings.noSelfHeal ? ' · Doctor: no self-heal' : ''}<br>
          ⏱ Night: ${view.settings.nightTimer ? Math.round(view.settings.nightTimer / 60) + ' min' : 'no limit'} ·
          Discussion: ${view.settings.dayTimer ? Math.round(view.settings.dayTimer / 60) + ' min' : 'no limit'}</p>` : ''}</div>`;
      html += profileCardHTML();
      html += chatCardHTML();
      if (!local && view.roomCode) {
        html += `<div class="card room-code-box">
          <div class="muted small-text">Invite others — scan to join room <strong>${esc(view.roomCode)}</strong></div>
          ${App.qrSvgFor(view.roomCode)}
          <div class="url">${esc(App.joinLinkFor(view.roomCode))}</div>
        </div>`;
      }
      html += playersListHTML(false);
    }

    /* ----- verdict reveal (short pause before night) ----- */
    else if (view.phase === 'verdict') {
      const a = view.announce || {};
      if (a.eliminatedName) {
        const you = a.eliminatedName === view.you.name;
        html += `<div class="banner death"><span class="big-emoji">⚖️</span>
          <h2>The village has spoken</h2>
          <p>The village ganged up on <strong>${esc(a.eliminatedName)}</strong> — they were eliminated.</p>
          <p><strong>${esc(a.eliminatedName)}</strong> was the
            <strong>${ROLES[a.eliminatedRole].icon} ${ROLES[a.eliminatedRole].name}</strong>.</p>
          ${you ? '<p><strong>That’s you — you’re out. 👻</strong></p>' : ''}</div>`;
      } else {
        html += `<div class="banner day"><span class="big-emoji">🕊</span>
          <h2>No one was eliminated</h2>
          <p class="muted">${a.tied ? 'The vote was tied.'
            : a.noMajority ? 'No majority was reached.'
            : 'The village chose to spare everyone.'}</p></div>`;
      }
      const vd = view.verdict || {};
      if (vd.lastWords) {
        html += `<div class="card center"><p>🗣 <em>“${esc(vd.lastWords)}”</em><br>
          <span class="muted small-text">— ${esc(a.eliminatedName || 'their')} last words</span></p></div>`;
      } else if (vd.canSay) {
        html += `<div class="card"><h3>🗣 Any last words?</h3>
          <div class="chat-row" style="margin-top:8px">
            <input id="last-words-input" type="text" maxlength="100" placeholder="Say something memorable…" autocomplete="off">
            <button id="last-words-send" class="btn primary">Send</button>
          </div></div>`;
      }
      html += `<p class="progress-note pulsing">Night falls in a moment…</p>`;
    }

    /* ----- dead player / late-joining spectator ----- */
    else if (view.phase !== 'ended' && !view.you.alive) {
      html += view.you.spectator
        ? `<div class="banner night"><span class="big-emoji">👁</span>
            <h2>You're spectating</h2>
            <p class="muted">This game is in progress — watch along, and you'll be dealt in automatically when the next one starts.</p></div>`
        : `<div class="banner death"><span class="big-emoji">👻</span>
            <h2>You are dead</h2>
            <p class="muted">You were the ${ROLES[view.you.role].name}. Sit back and watch — but don't give anything away!</p></div>`;
      html += announceHTML();
      // One vote from beyond the grave, if the host enabled it.
      if (view.phase === 'day' && view.vote && view.vote.ghost) {
        const v = view.vote;
        html += `<div class="card"><h3>👻 Your last vote</h3>
          <p class="muted small-text" style="margin-bottom:10px">One vote from beyond the grave — cast it today, or save it for a later day by not voting.</p>
          <div class="target-grid">${
            v.targets.filter(t => !t.self).map(t =>
              `<button class="btn ${v.yourVote === t.id ? 'selected' : ''}" data-vote="${t.id}">${t.avatar || ''} ${esc(t.name)}</button>`).join('')
          }${v.yourVote ? '<button class="btn ghost" data-vote="retract">↩ Take it back (save for later)</button>' : ''}</div></div>`;
      } else if (view.phase === 'day' && view.vote && view.vote.ghostSpent) {
        html += `<p class="progress-note">👻 Your last vote has been spent.</p>`;
      }
      html += playersListHTML(view.phase === 'day');
      if (view.phase === 'day') html += chatCardHTML();
    }

    /* ----- role confirmation before the first night ----- */
    else if (view.phase === 'reveal') {
      html += `<div class="banner night"><span class="big-emoji">🎭</span>
        <h2>The roles are dealt</h2>
        <p class="muted">Tap your card to secretly view your role, then confirm you're ready.</p></div>`;
      html += roleCardHTML(view.you.role, true);
      if (!view.reveal.confirmed && view.reveal.canPickRole) {
        html += `<div class="card"><h3>🧪 Solo test — choose your role</h3>
          <p class="muted small-text" style="margin-bottom:10px">Everyone else is a bot, so you can pick the role you want to try.</p>
          <div class="row-actions">${(view.reveal.pickableRoles || Object.keys(ROLES)).map(r =>
            `<button class="btn ${view.you.role === r ? 'selected' : ''}" data-pick-role="${r}">${ROLES[r].icon} ${ROLES[r].name}</button>`).join('')}
          </div></div>`;
      }
      if (view.reveal.confirmed) {
        html += `<div class="card center"><p class="pulsing">✅ Ready. Waiting for ${view.reveal.waitingOn} more player${view.reveal.waitingOn === 1 ? '' : 's'}…</p></div>`;
      } else {
        html += `<button id="btn-confirm-role" class="btn primary big" ${roleRevealed ? '' : 'disabled'}>
          ${roleRevealed ? "I've seen my role — I'm ready" : 'View your role first'}</button>`;
      }
    }

    /* ----- night ----- */
    else if (view.phase === 'night') {
      html += announceHTML();
      html += `<div class="banner night"><span class="big-emoji">🌙</span><h2>Night ${view.dayNum}</h2>
        ${view.timer ? '<p id="phase-timer" class="phase-timer"></p>' : ''}</div>`;
      html += roleCardHTML(view.you.role, true);

      const n = view.night;
      if (n.mates && n.mates.length) {
        html += `<div class="card"><h3>🔪 Your family</h3>${
          n.mates.map(m => `<p class="small-text">${m.avatar || ''} ${esc(m.name)} <span class="muted">(${esc(m.role)})</span> — ${
            m.pick ? `targeting <strong>${esc(m.pick)}</strong>` : '<span class="muted">deciding…</span>'}</p>`).join('')
        }<p class="hint">Killers should agree on one target — a split vote picks randomly among the top choices.</p></div>`;
      }
      html += intelHTML();

      if (!n.prompt) {
        html += `<div class="card center"><p class="pulsing">😴 You sleep soundly. Waiting for the night to end…</p></div>`;
      } else if (n.acted) {
        const actedMsg = n.actionSpecial === 'pledge' ? '📣 You will go public at dawn.'
          : n.actionSpecial === 'hide' ? '🎒 You are lying low tonight.'
          : n.actionSpecial === 'clean' ? '🧹 You will clean tonight’s kill.'
          : n.heldFire ? '🕊 You chose to sit tonight out.'
          : `✅ You chose <strong>${esc(n.actionTarget)}</strong>.`;
        html += `<div class="card center"><p>${actedMsg}</p>
          <p class="muted pulsing small-text">Waiting for ${n.waitingOn} more…</p></div>`;
      } else {
        html += `<div class="card"><h3>${esc(n.prompt)}</h3><div class="target-grid">${
          n.targets.map(t => `<button class="btn" data-night="${t.id}">${t.avatar || ''} ${esc(t.name)}</button>`).join('')
        }${n.canSkip ? `<button class="btn ghost" data-night="skip">${esc(n.skipLabel)}</button>` : ''}</div></div>`;
      }
    }

    /* ----- day / voting ----- */
    else if (view.phase === 'day') {
      html += `<div class="banner day"><span class="big-emoji">☀️</span><h2>Day ${view.dayNum}</h2>
        ${view.timer ? '<p id="phase-timer" class="phase-timer"></p>' : ''}</div>`;
      html += announceHTML();
      html += roleCardHTML(view.you.role, true);
      html += intelHTML();

      const v = view.vote;
      html += `<div class="card">
        <div class="section-title"><h3>Vote to eliminate</h3>
        <span class="muted small-text">${v.voted}/${v.needed} voted</span></div>
        <p class="muted small-text" style="margin-bottom:10px">Discuss, then cast your vote — you can change it until everyone has voted.
        A majority (<strong>${v.majority} votes</strong>) is needed to eliminate.</p>
        <div class="target-grid">${
          [...v.targets.map(t => ({ id: t.id, self: t.self, label: `${t.avatar || ''} ${esc(t.name)}${t.self ? ' (you)' : ''}` })),
           { id: 'nobody', label: '🕊 No one' }].map(t => {
            const votersHere = v.voters && v.voters[t.id] ? v.voters[t.id].map(esc).join(', ') : '';
            const count = v.counts[t.id] ? `${v.counts[t.id]} 🗳` : '';
            const inner = `<span class="vote-voters">${votersHere || '&nbsp;'}</span>
              <span class="vote-target">${count ? `<span class="vote-count">${count}</span>` : ''}${t.label}</span>`;
            return t.self
              ? `<div class="btn vote-line self-row">${inner}</div>`
              : `<button class="btn vote-line ${v.yourVote === t.id ? 'selected' : ''}" data-vote="${t.id}">${inner}</button>`;
          }).join('')
        }</div>
        </div>`;
      html += chatCardHTML();
    }

    /* ----- game over ----- */
    else if (view.phase === 'ended') {
      const myTeam = view.you.role ? ROLES[view.you.role].team : null;
      const won = !view.you.spectator && (
        view.winner === 'jester' ? view.you.role === 'jester'
        : myTeam === 'jester' ? false
        : (view.winner === 'mafia') === (myTeam === 'mafia'));
      if (won) {
        let pieces = '';
        for (let i = 0; i < 36; i++) {
          pieces += `<span class="confetti" style="left:${(Math.random() * 100).toFixed(1)}%;
            animation-duration:${(2.5 + Math.random() * 3).toFixed(2)}s;
            animation-delay:${(Math.random() * 2.5).toFixed(2)}s">${['🎉', '✨', '🎊'][i % 3]}</span>`;
        }
        html += `<div class="confetti-box" aria-hidden="true">${pieces}</div>`;
      }
      html += `<div class="banner win"><span class="big-emoji">${view.winner === 'town' ? '🎉' : view.winner === 'jester' ? '🃏' : '🔪'}</span>
        <h2>${view.winner === 'town' ? 'The town wins!' : view.winner === 'jester' ? 'The Jester wins!' : 'The mafia win!'}</h2>
        <p>${view.you.spectator
          ? 'Thanks for watching — you\'ll be dealt in next game.'
          : `${won ? 'You won! 🏆' : view.winner === 'jester' ? 'You all got played…' : 'Your team lost this time.'}
             You were the <strong>${ROLES[view.you.role].icon} ${ROLES[view.you.role].name}</strong>.`}</p>
        <p class="muted small-text">If the host starts a new game, you'll join it automatically.</p></div>`;

      if (view.extraWinners && view.extraWinners.length) {
        html += `<div class="card"><h3>🏅 Side winners</h3>${
          view.extraWinners.map(w => `<p class="small-text">${ROLES[w.role].icon} <strong>${esc(w.name)}</strong> — ${esc(w.why)}</p>`).join('')
        }</div>`;
      }
      if (view.recap) {
        if (view.recap.yours && view.recap.yours.length) {
          const verbs = {
            mafia: 'targeted', don: 'targeted', doctor: 'protected', detective: 'investigated',
            vigilante: 'shot at', watcher: 'watched', tracker: 'followed', coroner: 'examined',
            bodyguard: 'guarded', fixer: 'blocked', framer: 'framed', poisoner: 'poisoned',
            consigliere: 'studied', forger: 'marked', recruiter: 'approached', mortician: 'raised',
          };
          const specials = { pledge: 'pledged to go public 📣', hide: 'lay low 🎒', clean: 'cleaned the kill 🧹' };
          html += `<div class="card"><h3>🌙 Your nights</h3><div class="log">${
            view.recap.yours.map(x => `<div class="entry">Night ${x.night}: ${
              x.special ? specials[x.special]
              : x.skip ? 'did nothing'
              : `${verbs[x.role] || 'chose'} ${esc(x.target)}${x.result ? ` → <strong>${esc(x.result)}</strong>` : ''}`
            }</div>`).join('')
          }</div></div>`;
        }
        if (view.recap.timeline && view.recap.timeline.length) {
          html += `<div class="card"><h3>📜 How it went</h3><div class="log">${
            view.recap.timeline.map(txt => `<div class="entry">${esc(txt)}</div>`).join('')
          }</div></div>`;
        }
      }
      html += playersListHTML(false);
    }

    // Keep text inputs alive across re-renders (broadcasts arrive whenever
    // anyone joins, changes profile, chats, or votes).
    const prevInput = document.getElementById('profile-name');
    const wasFocused = prevInput && document.activeElement === prevInput;
    const selStart = wasFocused ? prevInput.selectionStart : 0;
    const prevChat = document.getElementById('chat-input');
    const chatFocused = prevChat && document.activeElement === prevChat;
    const chatSel = chatFocused ? prevChat.selectionStart : 0;

    c.innerHTML = html;

    const sendChat = () => {
      const ci = el('chat-input');
      if (!ci || !ci.value.trim()) return;
      sendAction({ t: 'chat', text: ci.value });
      chatDraft = '';
      ci.value = '';
      ci.focus();
    };
    const ci = el('chat-input');
    if (ci) {
      ci.oninput = () => { chatDraft = ci.value; };
      ci.onkeydown = e => { if (e.key === 'Enter') sendChat(); };
      if (chatFocused) {
        ci.focus();
        try { ci.setSelectionRange(chatSel, chatSel); } catch (e) {}
      }
    }
    const cs = el('chat-send');
    if (cs) cs.onclick = sendChat;
    const cl = el('chat-log');
    if (cl) cl.scrollTop = cl.scrollHeight;

    // Phase countdown: the host's clock is authoritative; adjust for skew and
    // tick locally so we don't need per-second broadcasts.
    clearInterval(phaseTickInterval);
    if (view.timer && el('phase-timer')) {
      const localDeadline = view.timer.deadline + (Date.now() - view.timer.hostNow);
      const tick = () => {
        const t = el('phase-timer');
        if (!t) { clearInterval(phaseTickInterval); return; }
        const rem = Math.max(0, Math.round((localDeadline - Date.now()) / 1000));
        t.textContent = rem > 0
          ? `⏱ ${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`
          : '⏱ Time’s up!';
        t.classList.toggle('urgent', rem > 0 && rem <= 30);
      };
      tick();
      phaseTickInterval = setInterval(tick, 1000);
    }

    const saveProfileName = () => {
      const pn = el('profile-name');
      if (pn) sendAction({ t: 'profile', name: pn.value });
    };
    const pn = el('profile-name');
    if (pn) {
      pn.oninput = () => { nameDraft = pn.value; };
      pn.onkeydown = e => { if (e.key === 'Enter') saveProfileName(); };
      if (wasFocused) {
        pn.focus();
        try { pn.setSelectionRange(selStart, selStart); } catch (e) {}
      }
    }
    const ps = el('profile-save');
    if (ps) ps.onclick = saveProfileName;
    c.querySelectorAll('[data-avatar]').forEach(b => {
      b.onclick = () => sendAction({ t: 'profile', avatar: b.dataset.avatar });
    });

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
    const cr = el('btn-confirm-role');
    if (cr) cr.onclick = () => sendAction({ t: 'confirm' });
    const lw = el('last-words-send');
    if (lw) lw.onclick = () => {
      const inp = el('last-words-input');
      if (inp && inp.value.trim()) sendAction({ t: 'lastWords', text: inp.value });
    };
    const lwi = el('last-words-input');
    if (lwi) lwi.onkeydown = e => {
      if (e.key === 'Enter' && lwi.value.trim()) sendAction({ t: 'lastWords', text: lwi.value });
    };
    c.querySelectorAll('[data-pick-role]').forEach(b => {
      b.onclick = () => sendAction({ t: 'pickRole', role: b.dataset.pickRole });
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
