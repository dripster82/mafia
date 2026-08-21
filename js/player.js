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
  let mafiaDraft = '';             // in-progress family-chat message
  let profileSavedFlash = 0;       // "✓ Saved" flash survives re-renders
  let phaseTickInterval = null;    // 1s countdown updater for the phase timer
  let lastTurnKey = null;          // chime once when it's your turn to act

  const el = id => document.getElementById(id);
  // A short buzz for phones in pockets (no-op where unsupported, e.g. iOS).
  const buzz = () => { try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {} };
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
        conn.send({ t: 'join', name: myName, playerId: getStoredPlayerId(), ach: myAchievementIds() });
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
    // A fatal rejection (kicked, name taken) voids the resume ticket — the
    // next load must not auto-dial the room that turned us away.
    try { sessionStorage.removeItem('mafia-session'); } catch (e) {}
    cleanup(true);
    App.showJoinError(msg);
  }

  /* Connection-level failure: stay on this screen with the debug log and a
   * retry button, instead of bouncing back to the join form. */
  function connFail(msg) {
    if (local) return;
    dbg('FAILED: ' + msg);
    // If we never reached this host at all, stop future loads auto-dialing
    // the same (likely dead) room; the retry button still works explicitly.
    if (!connected && !view) { try { sessionStorage.removeItem('mafia-session'); } catch (e) {} }
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
        if (key !== lastTurnKey) { lastTurnKey = key; if (prevPhase !== null) { Sound.play('turn'); buzz(); } }
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
      // A personal danger report deserves more than a quiet line of intel.
      if (/POISONED/.test(msg.line)) { Sound.play('danger'); buzz(); }
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
    if (kind === 'day') buzz(); // the vote is open — wake the pocket
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
        const poisonBadge = p.poisoned ? '<span class="status">☠️ poisoned</span>' : '';
        return `<div class="player-row ${p.alive ? '' : 'dead'}">
          ${p.alive ? `<span class="dot ${p.connected ? 'on' : 'off'}"></span>` : p.spectator ? '<span class="skull">👁</span>' : '<span class="skull">💀</span>'}
          <span class="name">${avatarHTML(p.avatar, { dead: !p.alive && !p.spectator, mayor: p.pledged && p.alive })} ${esc(p.name)}${p.isBot ? ' <span class="bot-tag">🤖</span>' : ''}${p.id === view.you.id ? ' (you)' : ''}</span>
          ${p.achievements && p.achievements.length
            ? `<button class="btn small ghost" data-ach="${p.id}">🏆 ${p.achievements.length}</button>`
            : p.achCount ? `<span class="status">🏆 ${p.achCount}</span>` : ''}
          ${mayorBadge}${poisonBadge}${role}${votes}${dead}</div>`;
      }).join('')
    }</div></div>`;
  }

  /* The voting grid — identical for the living and for ghost votes. Dead and
   * voted-out players stay listed, greyed out and unclickable. */
  /* Live pressure line: how close the leading candidate is to the drop. */
  function votePressureHTML(v) {
    let lead = null;
    v.targets.forEach(t => {
      const n = v.counts[t.id] || 0;
      if (!t.dead && n > 0 && (!lead || n > lead.n)) lead = { name: t.name, n };
    });
    if (!lead) return '';
    const gap = v.majority - lead.n;
    return `<p class="vote-pressure">${gap <= 0
      ? `⚖️ <strong>${esc(lead.name)}</strong> has a majority!`
      : `⚖️ <strong>${gap}</strong> more vote${gap > 1 ? 's' : ''} would eliminate <strong>${esc(lead.name)}</strong>`}</p>`;
  }

  function voteGridHTML(v, opts) {
    opts = opts || {};
    const deadLabels = { vote: 'voted out', vigilante: 'shot', poison: 'poisoned', guard: 'died guarding', mafia: 'killed' };
    const rows = v.targets.map(t => ({
      id: t.id, self: t.self, dead: t.dead, causeOfDeath: t.causeOfDeath, role: t.role,
      avatar: t.avatar, name: t.name, poisoned: t.poisoned,
    }));
    if (opts.includeNobody) rows.push({ id: 'nobody', avatar: '🕊', name: 'No one' });
    // The row closest to elimination gets highlighted.
    let leadId = null, leadN = 0;
    v.targets.forEach(t => { const n = v.counts[t.id] || 0; if (!t.dead && n > leadN) { leadN = n; leadId = t.id; } });
    return `<div class="target-grid">${
      rows.map(t => {
        const votersHere = v.voters && v.voters[t.id] ? v.voters[t.id].map(esc).join(', ') : '';
        const count = v.counts[t.id] || 0;
        // Fixed identity order: avatar → name → (you) → ☠️ → role icon.
        const who = `<span class="vote-who">${avatarHTML(t.avatar, { dead: t.dead, mayor: t.pledged && !t.dead })}
          <span class="vote-name">${esc(t.name)}${t.self ? ' (you)' : ''}</span>
          ${t.isBot ? '<span class="bot-tag">🤖</span>' : ''}
          ${t.poisoned ? '<span>☠️</span>' : ''}
          ${t.role ? `<span class="vote-roleic">${ROLES[t.role].icon}</span>` : ''}</span>`;
        const pill = t.dead
          ? `<span class="vote-deadpill">💀 ${deadLabels[t.causeOfDeath] || 'dead'}</span>`
          : count ? `<span class="vote-count-pill">${count} 🗳</span>` : '';
        const inner = `<span class="vote-top">${who}${pill}</span>
          ${votersHere ? `<span class="vote-under">↳ ${votersHere}</span>` : ''}`;
        const cls = `btn vote-line${t.id === leadId ? ' leading' : ''}${t.dead ? ' dead-row' : ''}${t.self ? ' self-row' : ''}`;
        return (t.dead || t.self || opts.readonly)
          ? `<div class="${cls}">${inner}</div>`
          : `<button class="${cls} ${v.yourVote === t.id ? 'selected' : ''}" data-vote="${t.id}">${inner}</button>`;
      }).join('')
    }${opts.retract && v.yourVote ? '<button class="btn ghost" data-vote="retract">↩ Take it back (save for a later day)</button>' : ''}</div>`;
  }

  /* Day-phase table talk. */
  function chatCardHTML() {
    if (!view.chat) return '';
    return `<div class="card"><h3>💬 Table talk</h3>
      <div id="chat-log" class="chat-log">${
        view.chat.length
          ? view.chat.map(m => m.divider
              ? `<div class="chat-divider">—— ${esc(m.divider)} ——</div>`
              : `<div class="chat-msg${m.chan === 'ghost' ? ' chat-ghost' : ''}"><span class="chat-who">${m.chan === 'ghost' ? '👻 ' : ''}${m.avatar || ''} ${esc(m.name)}${m.bot ? '<span class="bot-tag">🤖</span>' : ''}</span> ${esc(m.text)}</div>`).join('')
          : '<p class="muted small-text">No one has said anything yet…</p>'
      }</div>
      ${view.canChat ? `<div class="chat-row">
        <input id="chat-input" type="text" maxlength="200" placeholder="${view.ghostChat ? 'Whisper to the other ghosts…' : 'Say something…'}" autocomplete="off" value="${esc(chatDraft)}">
        <button id="chat-send" class="btn">Send</button>
      </div>${view.ghostChat ? '<p class="muted small-text">👻 Your whispers appear in the chat — but only the dead can see them.</p>' : ''}` : '<p class="muted small-text">The dead may listen, but not speak.</p>'}
    </div>`;
  }

  /* The mafia's private channel — shown only to living family members. */
  function mafiaChatCardHTML() {
    if (!view.mafiaChat) return '';
    return `<div class="card"><h3>🔪 Family chat</h3>
      <div id="mchat-log" class="chat-log chat-log-mafia">${
        view.mafiaChat.length
          ? view.mafiaChat.map(m => `<div class="chat-msg"><span class="chat-who">${m.avatar || ''} ${esc(m.name)}${m.bot ? '<span class="bot-tag">🤖</span>' : ''}</span> ${esc(m.text)}</div>`).join('')
          : '<p class="muted small-text">The family is quiet…</p>'
      }</div>
      <div class="chat-row">
        <input id="mchat-input" type="text" maxlength="200" placeholder="Only the family sees this…" autocomplete="off" value="${esc(mafiaDraft)}">
        <button id="mchat-send" class="btn">Send</button>
      </div></div>`;
  }

  /* "New messages" pill: chat lives below the vote card, so when a message
   * lands while the log is off-screen, float a pill that jumps you to it. */
  let chatSeenLen = 0;
  function updateChatPill() {
    const pillId2 = 'chat-new-pill';
    const old = document.getElementById(pillId2);
    const log = document.getElementById('chat-log');
    const total = view && view.chat ? view.chat.length : 0;
    const offScreen = log && log.getBoundingClientRect().top > window.innerHeight - 80;
    if (!log || !offScreen) {
      chatSeenLen = total;
      if (old) old.remove();
      return;
    }
    if (total > chatSeenLen) {
      if (old) return;
      const pill = document.createElement('button');
      pill.id = pillId2;
      pill.className = 'chat-new-pill';
      pill.textContent = '💬 New messages ↓';
      pill.onclick = () => {
        chatSeenLen = view && view.chat ? view.chat.length : 0;
        pill.remove();
        const l = document.getElementById('chat-log');
        if (l) l.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
      document.body.appendChild(pill);
    } else if (old) old.remove();
  }

  /* Floating role-guide: a 📖 button on every screen, full catalogue overlay. */
  let guideOpen = false;
  function guideHTML() {
    const fab = `<button id="btn-role-guide" class="guide-fab" title="Role guide">📖</button>`;
    if (!guideOpen) return fab;
    const all = Object.values(ROLES);
    const section = (title, roles) => `<p class="small-text muted" style="margin:12px 0 2px"><strong>${title}</strong></p>` +
      roles.map(r => `<p class="small-text" style="margin:6px 0"><strong>${r.icon} ${esc(r.name)}</strong><br>
        <span class="muted">${esc(r.desc)}</span></p>`).join('');
    return fab + `<div class="guide-overlay"><div class="guide-panel card">
      <div class="section-title"><h3>📖 Role guide</h3><button id="btn-guide-close" class="btn small">✕ Close</button></div>
      ${section('🏘 Village', all.filter(r => r.team === 'town'))}
      ${section('🔪 Mafia', all.filter(r => r.team === 'mafia'))}
      ${section('🎭 Neutral', all.filter(r => r.team !== 'town' && r.team !== 'mafia'))}
    </div></div>`;
  }

  /* "Previously…" — the story so far, shown each day. */
  function daySummaryHTML() {
    const s = view.daySummary;
    if (!s || !s.dead.length) return '';
    const deadLabel = { vote: 'voted out', vigilante: 'shot', poison: 'poisoned', guard: 'died guarding', mafia: 'killed' };
    return `<div class="card day-summary"><div class="section-title"><h3>📜 The story so far</h3>
      <span class="muted small-text">${s.alive} of ${s.total} alive</span></div>
      <p class="small-text muted" style="margin:4px 0 0">${
        s.dead.map(d => `${d.role ? ROLES[d.role].icon + ' ' : ''}${d.avatar || ''} ${esc(d.name)} <em>(${deadLabel[d.cause] || 'dead'})</em>`).join(' · ')
      }</p></div>`;
  }

  /* Who voted for whom on previous days. */
  function voteHistoryHTML() {
    const h = view.voteHistory;
    if (!h || !h.length) return '';
    return `<details class="card vote-history"><summary><strong>🗳 Past votes</strong></summary>${
      h.map(d => `<p class="small-text" style="margin:8px 0 2px"><strong>Day ${d.day}</strong></p>
        <p class="small-text muted" style="margin:0">${
          d.rows.length ? d.rows.map(r => `${esc(r.voter)} → ${esc(r.target)}`).join(' · ') : 'no votes cast'
        }</p>`).join('')
    }</details>`;
  }

  /* Avatar with a state ring: gold for the public mayor, grey for the dead. */
  function avatarHTML(avatar, { dead, mayor } = {}) {
    return `<span class="av${dead ? ' av-dead' : mayor ? ' av-mayor' : ''}">${avatar || ''}</span>`;
  }

  /* ---- Per-device record, kept in localStorage ---- */

  let newUnlocks = []; // achievements earned this game, for the ended screen

  /* The full catalogue, grouped under role/section headers.
   * `has(id)` decides which entries render lit vs dimmed. */
  function achievementListHTML(has) {
    return ACHIEVEMENT_GROUPS.map(g => {
      const gotHere = g.ids.filter(has).length;
      return `<p class="small-text muted ach-group" style="margin:12px 0 2px"><strong>${g.title}</strong>
          <span style="float:right">${gotHere}/${g.ids.length}</span></p>` +
        g.ids.map(id => {
          const a = ACHIEVEMENTS[id];
          if (!a) return '';
          return `<p class="small-text" style="margin:5px 0;${has(id) ? '' : 'opacity:0.4'}">${a.icon}
            <strong>${esc(a.name)}</strong>${a.shame ? ' 🙈' : ''} — <span class="muted">${esc(a.desc)}</span></p>`;
        }).join('');
    }).join('');
  }

  function myAchievementIds() {
    try {
      const store = JSON.parse(localStorage.getItem('mafia-achievements') || '{}');
      return Object.keys(store).filter(id => ACHIEVEMENTS[id]);
    } catch (e) { return []; }
  }

  function unlockAchievements(ids) {
    try {
      const store = JSON.parse(localStorage.getItem('mafia-achievements') || '{}');
      newUnlocks = ids.filter(id => ACHIEVEMENTS[id] && !store[id]);
      newUnlocks.forEach(id => { store[id] = Date.now(); });
      if (newUnlocks.length) localStorage.setItem('mafia-achievements', JSON.stringify(store));
    } catch (e) { newUnlocks = []; }
  }

  function recordStats() {
    const r = view.recap;
    if (!r || !r.gameId || !view.you.role || view.you.spectator) return;
    try {
      const s = JSON.parse(localStorage.getItem('mafia-stats') || '{}');
      if (s.lastGame === r.gameId) return;   // count each game once
      s.lastGame = r.gameId;
      s.games = (s.games || 0) + 1;
      const team = ROLES[view.you.role].team;
      if (r.youWon) {
        s.wins = (s.wins || 0) + 1;
        s.winStreak = (s.winStreak || 0) + 1;
        if (team === 'mafia') s.mafiaWins = (s.mafiaWins || 0) + 1;
        else if (team === 'town') s.townWins = (s.townWins || 0) + 1;
        else s.soloWins = (s.soloWins || 0) + 1;
      } else s.winStreak = 0;
      s.n1Streak = r.youDiedNight1 ? (s.n1Streak || 0) + 1 : 0;
      if (view.you.alive) s.survived = (s.survived || 0) + 1;
      localStorage.setItem('mafia-stats', JSON.stringify(s));
      // Cross-game achievements come from the device's own record;
      // single-game ones arrive from the host with the recap.
      const cross = [];
      if ((s.wins || 0) >= 1) cross.push('first-blood');
      if ((s.winStreak || 0) >= 3) cross.push('hat-trick');
      if ((s.mafiaWins || 0) >= 5) cross.push('made-man');
      if ((s.townWins || 0) >= 5) cross.push('pillar');
      if ((s.n1Streak || 0) >= 3) cross.push('boots-on');
      unlockAchievements([...(r.achievements || []), ...cross]);
      // Refresh the trophy cabinet the host shows next to our name.
      sendAction({ t: 'achShare', ach: myAchievementIds() });
    } catch (e) {}
  }

  /* Game-over achievements card: fresh unlocks up top, full catalogue folded. */
  function achievementsCardHTML() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem('mafia-achievements') || '{}'); } catch (e) {}
    const total = Object.keys(ACHIEVEMENTS).length;
    const got = Object.keys(store).filter(id => ACHIEVEMENTS[id]).length;
    return `<div class="card">
      <div class="section-title"><h3>🏆 Achievements</h3><span class="muted small-text">${got}/${total} unlocked</span></div>
      ${newUnlocks.length
        ? newUnlocks.map(id => `<p class="small-text ach-new">✨ <strong>${ACHIEVEMENTS[id].icon} ${esc(ACHIEVEMENTS[id].name)}</strong><br>
            <span class="muted">${esc(ACHIEVEMENTS[id].desc)}</span></p>`).join('')
        : '<p class="muted small-text">No new achievements this game.</p>'}
      <details style="margin-top:8px"><summary class="small-text muted" style="cursor:pointer">All achievements</summary>${
        achievementListHTML(id => !!store[id])
      }</details></div>`;
  }

  function statsCardHTML() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('mafia-stats') || 'null'); } catch (e) {}
    if (!s || !s.games) return '';
    return `<div class="card"><h3>📈 Your record on this device</h3>
      <p class="small-text muted" style="margin:4px 0 0">
        ${s.games} game${s.games > 1 ? 's' : ''} · ${s.wins || 0} won
        ${s.townWins ? ` · 🏘 ${s.townWins} as village` : ''}
        ${s.mafiaWins ? ` · 🔪 ${s.mafiaWins} as mafia` : ''}
        ${s.soloWins ? ` · 🎭 ${s.soloWins} solo` : ''}
        ${s.survived ? ` · 🌅 survived ${s.survived}` : ''}</p></div>`;
  }

  /* Trophy room: a 🏆 button on every screen. Shows your own cabinet, or —
   * from the lobby list — another player's shared unlocks. */
  let trophyOpen = false;
  let trophyViewId = null;
  function trophyHTML() {
    const fab = `<button id="btn-trophies" class="guide-fab trophy-fab" title="Achievements">🏆</button>`;
    if (!trophyOpen) return fab;
    let title = '🏆 Your achievements';
    let ids = null; // null = read your own from this device
    if (trophyViewId && view.players) {
      const pl = view.players.find(x => x.id === trophyViewId);
      if (pl && pl.achievements) { title = `🏆 ${esc(pl.name)}’s achievements`; ids = pl.achievements; }
    }
    let store = {};
    if (!ids) { try { store = JSON.parse(localStorage.getItem('mafia-achievements') || '{}'); } catch (e) {} }
    const has = id => ids ? ids.includes(id) : !!store[id];
    const all = Object.keys(ACHIEVEMENTS);
    const got = all.filter(has).length;
    return fab + `<div class="guide-overlay trophy-overlay"><div class="guide-panel card">
      <div class="section-title"><h3>${title}</h3><button id="btn-trophies-close" class="btn small">✕ Close</button></div>
      <p class="muted small-text" style="margin:2px 0 6px">${got}/${all.length} unlocked</p>
      ${achievementListHTML(has)}
    </div></div>`;
  }

  /* Lobby-only: rename yourself and pick an avatar. */
  function profileCardHTML() {
    const av = view.you.avatar;
    return `<div class="card"><h3>Your profile</h3>
      <div class="profile-row">
        <input id="profile-name" type="text" maxlength="16" autocomplete="off"
          value="${esc(nameDraft !== null ? nameDraft : view.you.name)}">
        <button id="profile-save" class="btn">${Date.now() - profileSavedFlash < 1500 ? '✓ Saved' : 'Save'}</button>
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
        const reveal = !view.settings || view.settings.revealOnDeath !== false;
        parts.push(`<strong>${esc(k.name)}</strong> ${how} in the night${
          k.role ? ` — they were the <strong>${ROLES[k.role].icon} ${ROLES[k.role].name}</strong>.`
                 : reveal ? ' — their body was left unrecognisable. 🧹' : '.'}`);
      });
      if (a.curedName) parts.push(
        `💊 The doctor saved <strong>${esc(a.curedName)}</strong> from the poison!`);
      if (a.woundedNames && a.woundedNames.length) parts.push(
        `<strong>${a.woundedNames.map(esc).join(' and ')}</strong> ${a.woundedNames.length > 1 ? 'were' : 'was'} wounded in the night — but survived!`);
      if (a.savedName) parts.push(`<strong>${esc(a.savedName)}</strong> was attacked, but the doctor saved them!`);
      else if (a.saved) parts.push('The doctor saved someone from an attack in the night!');
      if (a.revivedName) parts.push(`⚰️ A miracle — <strong>${esc(a.revivedName)}</strong> has risen from the dead!`);
      if (a.mayorName) parts.push(`📣 <strong>${esc(a.mayorName)}</strong> is the Mayor — proven village, and their vote now counts double.`);
      if (!parts.length) parts.push('No one died in the night.');
      if (a.rumour) parts.push(`🗣 <em>${esc(a.rumour)}</em>`);
      const grim = (a.killed && a.killed.length) || (a.woundedNames && a.woundedNames.length);
      return `<div class="banner ${grim ? 'death' : 'day'}">
        <span class="big-emoji">${a.killed && a.killed.length ? '💀' : a.woundedNames && a.woundedNames.length ? '🩹' : a.saved ? '💉' : a.revivedName ? '⚰️' : '🌤'}</span>
        <p>${parts.join('</p><p>')}</p></div>`;
    }
    if (view.phase === 'night' && a.kind === 'verdict' && view.dayNum > 1) {
      if (a.eliminatedName) {
        return `<div class="banner death"><p>The village ganged up on <strong>${esc(a.eliminatedName)}</strong> — ${
          a.eliminatedRole ? `they were the <strong>${ROLES[a.eliminatedRole].name}</strong>` : 'they were eliminated'}.</p></div>`;
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
          ${view.settings.noSelfHeal ? ' · Doctor: no self-heal' : ''}
          ${view.settings.lastWords === false ? ' · No last words' : ''}
          ${view.settings.revealOnDeath === false ? ' · Roles stay secret on death' : ''}<br>
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
          ${a.eliminatedRole ? `<p><strong>${esc(a.eliminatedName)}</strong> was the
            <strong>${ROLES[a.eliminatedRole].icon} ${ROLES[a.eliminatedRole].name}</strong>.</p>`
          : `<p class="muted">Their role goes with them to the grave.</p>`}
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
          <p class="muted small-text" style="margin-top:4px">Everyone is waiting to hear them.</p>
          <div class="chat-row" style="margin-top:8px">
            <input id="last-words-input" type="text" maxlength="100" placeholder="Say something memorable…" autocomplete="off">
            <button id="last-words-send" class="btn primary">Send</button>
          </div>
          <button id="last-words-skip" class="btn ghost" style="width:100%;margin-top:8px">🙊 Say nothing</button></div>`;
      }
      html += vd.waiting && !vd.canSay
        ? `<p class="progress-note pulsing">🗣 Waiting for ${esc(vd.waitingName || 'their')}'s last words…</p>`
        : vd.canSay ? ''
        : `<p class="progress-note pulsing">Night falls in a moment…</p>`;
    }

    /* ----- dead player / late-joining spectator ----- */
    else if (view.phase !== 'ended' && !view.you.alive) {
      html += view.you.spectator
        ? `<div class="banner night"><span class="big-emoji">👁</span>
            <h2>You're spectating</h2>
            <p class="muted">This game is in progress — watch along, and you'll be dealt in automatically when the next one starts.</p>
            <p class="muted small-text">💬 During the day you can whisper with the dead in the chat below.</p></div>`
        : `<div class="banner death"><span class="big-emoji">👻</span>
            <h2>You are dead</h2>
            <p class="muted">You were the ${ROLES[view.you.role].name}. Sit back and watch — but don't give anything away!</p></div>`;
      html += announceHTML();
      html += daySummaryHTML();
      // During the day the dead see the vote list (their ghost vote if they
      // have one, read-only otherwise) — no separate players list.
      if (view.phase === 'day' && view.vote) {
        const v = view.vote;
        if (v.ghost) {
          html += `<div class="card">
            <div class="section-title"><h3>👻 Your last vote</h3>
            <span class="muted small-text">${v.voted}/${v.needed} voted</span></div>
            <p class="muted small-text" style="margin-bottom:10px">One vote from beyond the grave — cast it today, or save it for a later day.
            A majority (<strong>${v.majority} votes</strong>) is needed to eliminate.</p>
            ${v.ghostSaved ? '<p class="progress-note" style="margin-bottom:10px">💾 Saved for a later day — you can still change your mind below.</p>' : ''}
            ${voteGridHTML(v, { retract: true })}
            ${!v.yourVote && !v.ghostSaved ? '<button class="btn ghost" data-vote="save" style="width:100%;margin-top:8px">💾 Save my vote for a later day</button>' : ''}
          </div>`;
        } else {
          html += `<div class="card">
            <div class="section-title"><h3>🗳 The vote</h3>
            <span class="muted small-text">${v.voted}/${v.needed} voted</span></div>
            ${v.ghostSpent ? '<p class="muted small-text" style="margin-bottom:10px">👻 Your last vote has been spent.</p>' : ''}
            ${voteGridHTML(v, { includeNobody: true, readonly: true })}
            ${v.closing ? '<p class="progress-note pulsing" style="margin-top:10px">🗳 All votes are in — locking in…</p>'
              : v.ghostsPending ? `<p class="progress-note" style="margin-top:10px">👻 Waiting on ${v.ghostsPending} ghost vote${v.ghostsPending > 1 ? 's' : ''}…</p>` : ''}
          </div>`;
        }
        html += voteHistoryHTML();
        html += chatCardHTML();
      } else {
        html += playersListHTML(false);
      }
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
          n.mates.map(m => `<p class="small-text">${m.avatar || ''} ${esc(m.name)}${m.isBot ? ' <span class="bot-tag">🤖</span>' : ''} <span class="muted">(${esc(m.role)})</span> — ${
            m.pick ? `targeting <strong>${esc(m.pick)}</strong>` : '<span class="muted">deciding…</span>'}</p>`).join('')
        }<p class="hint">Killers should agree on one target — a split vote picks randomly among the top choices.</p></div>`;
      }
      html += intelHTML();

      if (!n.prompt) {
        html += `<div class="card center"><p class="pulsing">😴 You sleep soundly. Waiting for the night to end…</p>
          ${n.waitingNames && n.waitingNames.length ? `<p class="muted small-text">Still to act: ${n.waitingNames.map(esc).join(', ')}</p>` : ''}</div>`;
      } else if (n.acted) {
        const actedMsg = n.actionSpecial === 'pledge' ? '📣 You will go public at dawn.'
          : n.actionSpecial === 'hide' ? '🎒 You are lying low tonight.'
          : n.actionSpecial === 'clean' ? '🧹 You will clean tonight’s kill.'
          : n.heldFire ? '🕊 You chose to sit tonight out.'
          : `✅ You chose <strong>${esc(n.actionTarget)}</strong>.`;
        html += `<div class="card center"><p>${actedMsg}</p>
          <p class="muted pulsing small-text">Waiting for ${n.waitingOn} more…</p>
          ${n.waitingNames && n.waitingNames.length ? `<p class="muted small-text">Still to act: ${n.waitingNames.map(esc).join(', ')}</p>` : ''}</div>`;
      } else {
        html += `<div class="card"><h3>${esc(n.prompt)}</h3><div class="target-grid">${
          n.targets.map(t => `<button class="btn" data-night="${t.id}">${t.avatar || ''} ${esc(t.name)}</button>`).join('')
        }${n.canSkip ? `<button class="btn ghost" data-night="skip">${esc(n.skipLabel)}</button>` : ''}</div></div>`;
      }
      html += mafiaChatCardHTML();
    }

    /* ----- day / voting ----- */
    else if (view.phase === 'day') {
      html += `<div class="banner day"><span class="big-emoji">☀️</span><h2>Day ${view.dayNum}</h2>
        ${view.timer ? '<p id="phase-timer" class="phase-timer"></p>' : ''}</div>`;
      html += announceHTML();
      html += daySummaryHTML();
      html += roleCardHTML(view.you.role, true);
      html += intelHTML();

      const v = view.vote;
      html += `<div class="card">
        <div class="section-title"><h3>Vote to eliminate</h3>
        <span class="muted small-text">${v.voted}/${v.needed} voted</span></div>
        <p class="muted small-text" style="margin-bottom:10px">Discuss, then cast your vote — you can change it until everyone has voted.
        A majority (<strong>${v.majority} votes</strong>) is needed to eliminate.</p>
        ${votePressureHTML(v)}
        ${voteGridHTML(v, { includeNobody: true })}
        ${v.closing ? '<p class="progress-note pulsing" style="margin-top:10px">🗳 All votes are in — locking in…</p>'
          : v.ghostsPending ? `<p class="progress-note" style="margin-top:10px">👻 Waiting on ${v.ghostsPending} ghost vote${v.ghostsPending > 1 ? 's' : ''}…</p>` : ''}
        </div>`;
      html += voteHistoryHTML();
      html += mafiaChatCardHTML();
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
        const verbs = {
          mafia: 'targeted', don: 'targeted', doctor: 'protected', detective: 'investigated',
          vigilante: 'shot at', watcher: 'watched', tracker: 'followed', coroner: 'examined',
          bodyguard: 'guarded', fixer: 'blocked', framer: 'framed', poisoner: 'poisoned',
          consigliere: 'studied', forger: 'marked', recruiter: 'approached', mortician: 'tried to raise',
        };
        const specials = { pledge: 'pledged to go public 📣', hide: 'lay low 🎒', clean: 'cleaned the kill 🧹' };
        const actionLine = x =>
          `<div class="entry">Night ${x.night}: ${
            x.special ? specials[x.special]
            : x.skip ? 'did nothing'
            : `${verbs[x.role] || 'chose'} ${esc(x.target)}${x.result ? ` → <strong>${esc(x.result)}</strong>` : ''}`
          }</div>`;
        if (view.recap.all && view.recap.all.length) {
          html += `<div class="card"><h3>🌙 Everyone's nights</h3>${
            view.recap.all.map(pl => `
              <p class="small-text" style="margin:10px 0 4px"><strong>${pl.avatar || ''} ${esc(pl.name)}</strong>
                <span class="muted">(${ROLES[pl.role].icon} ${ROLES[pl.role].name})</span>${pl.you ? ' (you)' : ''}</p>
              ${pl.actions.length
                ? `<div class="log">${pl.actions.map(actionLine).join('')}</div>`
                : '<p class="muted small-text">slept soundly every night</p>'}`).join('')
          }</div>`;
        } else if (view.recap.yours && view.recap.yours.length) {
          html += `<div class="card"><h3>🌙 Your nights</h3><div class="log">${
            view.recap.yours.map(actionLine).join('')
          }</div></div>`;
        }
        if (view.recap.timeline && view.recap.timeline.length) {
          html += `<div class="card"><h3>📜 How it went</h3><div class="log">${
            view.recap.timeline.map(txt => `<div class="entry">${esc(txt)}</div>`).join('')
          }</div></div>`;
        }
      }
      recordStats();
      html += achievementsCardHTML();
      html += voteHistoryHTML();
      html += statsCardHTML();
      html += `<button id="btn-copy-result" class="btn" style="width:100%;margin-top:8px">📋 Copy result summary</button>`;
      html += playersListHTML(false);
    }

    // Solo-mode debug: each bot's personal suspicion table.
    if (view.suspicionDebug) {
      html += `<div class="card"><h3>🧪 Bot suspicion — solo debug</h3>
        <p class="muted small-text" style="margin:4px 0 8px">Each bot's own reads (−6 trusted … +10 suspect), its credulity, and how accused it feels (heat).</p>
        ${view.suspicionDebug.map(b => `
          <p class="small-text" style="margin:8px 0 2px"><strong>${b.avatar || ''} ${esc(b.name)}</strong>
            <span class="muted">${b.persona ? `· ${b.persona} ` : ''}· credulity ×${b.credulity}${b.heat ? ` · heat ${b.heat}` : ''}</span></p>
          <p class="small-text muted" style="margin:0">${
            b.sees.length
              ? b.sees.map(x => `${x.avatar || ''} ${esc(x.name)} <strong class="${x.score > 0 ? 'susp-pos' : 'susp-neg'}">${x.score > 0 ? '+' : ''}${x.score}</strong>`).join(' · ')
              : 'no reads yet'
          }</p>`).join('')}</div>`;
    }

    html += guideHTML();
    html += trophyHTML();

    // Keep text inputs alive across re-renders (broadcasts arrive whenever
    // anyone joins, changes profile, chats, or votes).
    const prevInput = document.getElementById('profile-name');
    const wasFocused = prevInput && document.activeElement === prevInput;
    const selStart = wasFocused ? prevInput.selectionStart : 0;
    const prevChat = document.getElementById('chat-input');
    const chatFocused = prevChat && document.activeElement === prevChat;
    const chatSel = chatFocused ? prevChat.selectionStart : 0;
    const prevMChat = document.getElementById('mchat-input');
    const mchatFocused = prevMChat && document.activeElement === prevMChat;
    const mchatSel = mchatFocused ? prevMChat.selectionStart : 0;
    // The role guide must not jump to the top when a broadcast re-renders,
    // and the past-votes fold must not snap shut.
    const prevGuide = c.querySelector('.guide-panel');
    const guideScroll = prevGuide ? prevGuide.scrollTop : 0;
    const prevHist = c.querySelector('.vote-history');
    const histOpen = prevHist ? prevHist.open : false;

    c.innerHTML = html;

    const gp = c.querySelector('.guide-panel');
    if (gp && guideScroll) gp.scrollTop = guideScroll;
    const vh = c.querySelector('.vote-history');
    if (vh && histOpen) vh.open = true;

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

    const sendMChat = () => {
      const mi = el('mchat-input');
      if (!mi || !mi.value.trim()) return;
      sendAction({ t: 'chat', text: mi.value, chan: 'mafia' });
      mafiaDraft = '';
      mi.value = '';
      mi.focus();
    };
    const mi = el('mchat-input');
    if (mi) {
      mi.oninput = () => { mafiaDraft = mi.value; };
      mi.onkeydown = e => { if (e.key === 'Enter') sendMChat(); };
      if (mchatFocused) {
        mi.focus();
        try { mi.setSelectionRange(mchatSel, mchatSel); } catch (e) {}
      }
    }
    const ms = el('mchat-send');
    if (ms) ms.onclick = sendMChat;
    const mcl = el('mchat-log');
    if (mcl) mcl.scrollTop = mcl.scrollHeight;

    const gb = el('btn-role-guide');
    if (gb) gb.onclick = () => { guideOpen = true; render(); };
    const gc = el('btn-guide-close');
    if (gc) gc.onclick = () => { guideOpen = false; render(); };
    const go = c.querySelector('.guide-overlay:not(.trophy-overlay)');
    if (go) go.onclick = e => { if (e.target === go) { guideOpen = false; render(); } };

    const tb = el('btn-trophies');
    if (tb) tb.onclick = () => { trophyOpen = true; trophyViewId = null; render(); };
    const tc = el('btn-trophies-close');
    if (tc) tc.onclick = () => { trophyOpen = false; trophyViewId = null; render(); };
    const to = c.querySelector('.trophy-overlay');
    if (to) to.onclick = e => { if (e.target === to) { trophyOpen = false; trophyViewId = null; render(); } };
    c.querySelectorAll('[data-ach]').forEach(b => {
      b.onclick = () => { trophyViewId = b.dataset.ach; trophyOpen = true; render(); };
    });

    const copyBtn = el('btn-copy-result');
    if (copyBtn) copyBtn.onclick = () => {
      const lines = [`🕵️ Mafia Night — ${view.winner === 'town' ? 'the town wins!' : view.winner === 'mafia' ? 'the mafia win!' : view.winner === 'jester' ? 'the Jester wins!' : 'game over'}`];
      (view.extraWinners || []).forEach(w => lines.push(`🏅 ${w.name} (${ROLES[w.role].name}) also wins — ${w.why}`));
      if (view.recap && view.recap.all) {
        lines.push('');
        view.recap.all.forEach(x => lines.push(`${x.avatar || ''} ${x.name} — ${ROLES[x.role].icon} ${ROLES[x.role].name}`));
      }
      if (view.recap && view.recap.timeline && view.recap.timeline.length) {
        lines.push('');
        view.recap.timeline.forEach(t => lines.push(`• ${t}`));
      }
      const text = lines.join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { const b = el('btn-copy-result'); if (b) b.textContent = '📋 Copy result summary'; }, 1500); })
        .catch(() => prompt('Copy the result:', text));
    };

    updateChatPill();

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
        // A soft heartbeat as the vote clock runs down.
        if (view.phase === 'day' && rem > 0 && rem <= 10) Sound.play('tick');
      };
      tick();
      phaseTickInterval = setInterval(tick, 1000);
    }

    const saveProfileName = () => {
      const pn = el('profile-name');
      if (!pn) return;
      sendAction({ t: 'profile', name: pn.value });
      // Remember the new name for future games too.
      try { if (pn.value.trim()) localStorage.setItem('mafia-name', pn.value.trim()); } catch (e) {}
      // Instant feedback — the confirming broadcast re-render keeps it via the flag.
      profileSavedFlash = Date.now();
      const b = el('profile-save');
      if (b) b.textContent = '✓ Saved';
      setTimeout(() => { profileSavedFlash = 0; const b2 = el('profile-save'); if (b2) b2.textContent = 'Save'; }, 1500);
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
    const lws = el('last-words-skip');
    if (lws) lws.onclick = () => sendAction({ t: 'lastWords', text: '__skip__' });
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
