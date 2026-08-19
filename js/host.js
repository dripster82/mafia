/* Host: authoritative game engine + operator controls.
 * The host device runs the game; players connect to it via WebRTC (PeerJS).
 * The host is also a player — their client attaches through an in-memory
 * loopback connection, and the app itself acts as the neutral operator.
 * The host UI must therefore never reveal hidden information. */

const Host = (() => {
  const PEER_PREFIX = 'mafia-night-v1-';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O to avoid confusion

  let peer = null;
  let roomCode = null;
  let conns = {};      // playerId -> DataConnection (or the local loopback)
  let localConn = null; // the host's own loopback connection
  let hostName = null;
  let G = null;        // game state

  /* ---------------- state ---------------- */

  function freshGame() {
    return {
      phase: 'lobby',      // lobby | night | day | ended
      dayNum: 0,
      players: [],         // {id, name, role, alive, connected, causeOfDeath}
      night: null,         // {actions: {playerId: targetId}}
      votes: null,         // {playerId: targetId|'nobody'}
      announce: null,      // latest event to show players
      winner: null,
      log: [],             // public information only — the host can read this
    };
  }

  function alivePlayers() { return G.players.filter(p => p.alive); }
  function aliveMafia() { return alivePlayers().filter(p => p.role === 'mafia'); }
  function getPlayer(id) { return G.players.find(p => p.id === id); }
  function nameOf(id) { const p = getPlayer(id); return p ? p.name : '?'; }

  function addLog(text, important) {
    G.log.push({ text, important: !!important });
  }

  /* ---------------- lifecycle ---------------- */

  function create(name) {
    hostName = String(name || '').trim().slice(0, 16) || 'Host';
    roomCode = '';
    for (let i = 0; i < 5; i++) roomCode += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    G = freshGame();
    conns = {};

    // The host screen holds two areas: our controls, and the host's own
    // player view (rendered by the Player module through the loopback).
    document.getElementById('host-content').innerHTML =
      '<div id="host-player-area"></div><div id="host-controls-area"></div>';

    attachLocalPlayer(hostName);

    peer = new Peer(PEER_PREFIX + roomCode, Object.assign({ debug: 1 }, window.MAFIA_PEER_CONFIG || {}));
    peer.on('open', () => {
      document.getElementById('host-room-pill').textContent = 'Room: ' + roomCode;
      render();
    });
    peer.on('connection', conn => {
      conn.on('data', msg => handleMessage(conn, msg));
      conn.on('close', () => handleDisconnect(conn));
      conn.on('error', () => handleDisconnect(conn));
    });
    peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        // Code collision — extremely unlikely, just pick another.
        peer.destroy();
        create(hostName);
      } else if (err.type !== 'peer-unavailable') {
        renderFatal('Connection error: ' + err.type + '. Refresh to try again.');
      }
    });
    peer.on('disconnected', () => {
      // Lost connection to the signalling broker; existing player links keep
      // working, but new players can't join. Try to get it back.
      try { peer.reconnect(); } catch (e) { /* destroyed */ }
    });
    render();
  }

  /* The host's own seat: a fake connection that loops straight into the
   * Player module on this same page. */
  function attachLocalPlayer(name) {
    localConn = {
      open: true,
      send: msg => Player.receiveLocal(msg),
      close: () => {},
      _playerId: null,
    };
    Player.initLocal(name, msg => handleMessage(localConn, msg));
    handleJoin(localConn, { t: 'join', name });
  }

  function destroy() {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; G = null; conns = {}; localConn = null;
  }

  /* ---------------- messaging ---------------- */

  function send(playerId, msg) {
    const c = conns[playerId];
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  }

  function handleDisconnect(conn) {
    const p = G && G.players.find(pl => pl.id === conn._playerId);
    if (p) {
      if (conns[p.id] === conn) {
        p.connected = false;
        delete conns[p.id];
      }
      if (G.phase === 'lobby') {
        // In the lobby a leaver is simply removed.
        G.players = G.players.filter(pl => pl.id !== p.id);
      }
      broadcast();
    }
  }

  function handleMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return handleJoin(conn, msg);
    const p = G.players.find(pl => pl.id === conn._playerId);
    if (!p) return;
    if (msg.t === 'night') return handleNightAction(p, msg.target);
    if (msg.t === 'vote') return handleVote(p, msg.target);
  }

  function handleJoin(conn, msg) {
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) { conn.send({ t: 'error', fatal: true, msg: 'Please enter a name.' }); return; }

    // Reconnect: known playerId, or (after start) same name on a vacated seat.
    let p = msg.playerId ? G.players.find(pl => pl.id === msg.playerId) : null;
    if (!p && G.phase !== 'lobby') {
      p = G.players.find(pl => !pl.connected && pl.name.toLowerCase() === name.toLowerCase());
    }

    if (p) {
      if (p.connected && conns[p.id] && conns[p.id].open && conns[p.id] !== conn) {
        conn.send({ t: 'error', fatal: true, msg: 'That player is already connected on another device.' });
        return;
      }
    } else {
      if (G.phase !== 'lobby') {
        conn.send({ t: 'error', fatal: true, msg: 'This game has already started.' });
        return;
      }
      if (G.players.some(pl => pl.name.toLowerCase() === name.toLowerCase())) {
        conn.send({ t: 'error', fatal: true, msg: 'That name is taken — pick another.' });
        return;
      }
      p = {
        id: 'p' + Math.random().toString(36).slice(2, 10),
        name, role: null, alive: true, connected: true, causeOfDeath: null,
      };
      G.players.push(p);
    }

    p.connected = true;
    conn._playerId = p.id;
    conns[p.id] = conn;
    conn.send({ t: 'joined', playerId: p.id, roomCode });
    broadcast();
  }

  /* ---------------- game flow ---------------- */

  function startGame() {
    const connected = G.players.filter(p => p.connected);
    if (connected.length < MIN_PLAYERS) return;
    // Drop anyone who left the lobby before start.
    G.players = connected;
    const deck = buildRoleDeck(G.players.length);
    G.players.forEach((p, i) => { p.role = deck[i]; p.alive = true; });
    addLog(`Game started with ${G.players.length} players (${roleSummary(G.players.length)}).`, true);
    startNight();
  }

  function startNight() {
    G.dayNum += 1;
    G.phase = 'night';
    G.night = { actions: {} };
    G.votes = null;
    addLog(`Night ${G.dayNum} falls. The town sleeps.`);
    broadcast();
  }

  function nightActors() {
    return alivePlayers().filter(p => ROLES[p.role].nightPrompt);
  }

  function handleNightAction(p, targetId) {
    if (G.phase !== 'night' || !p.alive || !ROLES[p.role].nightPrompt) return;
    const validTargets = nightTargetsFor(p).map(t => t.id);
    if (!validTargets.includes(targetId)) return;
    G.night.actions[p.id] = targetId;

    // A detective learns the result as soon as they investigate.
    // (Kept out of the game log — the host is a player and must not see it.)
    if (p.role === 'detective') {
      const target = getPlayer(targetId);
      send(p.id, { t: 'investigation', name: target.name, isMafia: target.role === 'mafia' });
    }

    maybeResolveNight();
    broadcast();
  }

  function nightTargetsFor(p) {
    if (p.role === 'mafia') return alivePlayers().filter(t => t.role !== 'mafia');
    if (p.role === 'doctor') return alivePlayers();
    if (p.role === 'detective') return alivePlayers().filter(t => t.id !== p.id);
    return [];
  }

  function maybeResolveNight() {
    const pending = nightActors().filter(p => !(p.id in G.night.actions));
    if (pending.length === 0) resolveNight();
  }

  function forceEndNight() {
    // Missing actors simply take no action tonight.
    resolveNight(true);
  }

  function resolveNight(forced) {
    if (G.phase !== 'night') return;

    // Mafia kill: plurality of mafia picks; tie broken at random.
    const mafiaPicks = aliveMafia()
      .map(m => G.night.actions[m.id])
      .filter(Boolean);
    let killTarget = null;
    if (mafiaPicks.length) {
      const tally = {};
      mafiaPicks.forEach(t => { tally[t] = (tally[t] || 0) + 1; });
      const max = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter(t => tally[t] === max);
      killTarget = top[Math.floor(Math.random() * top.length)];
    }

    const doctor = alivePlayers().find(p => p.role === 'doctor');
    const savedId = doctor ? G.night.actions[doctor.id] : null;

    let killed = null;
    let saved = false;
    if (killTarget) {
      if (killTarget === savedId) {
        saved = true;
        addLog(`The mafia struck, but the doctor saved their target!`, true);
      } else {
        const victim = getPlayer(killTarget);
        victim.alive = false;
        victim.causeOfDeath = 'mafia';
        killed = victim;
        addLog(`${victim.name} was killed in the night. They were the ${ROLES[victim.role].name}.`, true);
      }
    } else {
      addLog(forced ? 'The night was ended early — no one was attacked.' : 'The mafia took no action tonight.');
    }

    G.announce = {
      kind: 'dawn',
      killedName: killed ? killed.name : null,
      killedRole: killed ? killed.role : null,
      saved,
    };

    if (checkWin()) return;

    G.phase = 'day';
    G.votes = {};
    addLog(`Day ${G.dayNum} begins. The town votes.`);
    broadcast();
  }

  function handleVote(p, targetId) {
    if (G.phase !== 'day' || !p.alive) return;
    const valid = targetId === 'nobody' ||
      (alivePlayers().some(t => t.id === targetId) && targetId !== p.id);
    if (!valid) return;
    G.votes[p.id] = targetId;
    const pending = alivePlayers().filter(v => !(v.id in G.votes));
    if (pending.length === 0) resolveVote();
    broadcast();
  }

  function forceEndVoting() { resolveVote(true); }

  function resolveVote(forced) {
    if (G.phase !== 'day') return;

    const cast = Object.values(G.votes);
    const tally = { nobody: 0 };
    cast.forEach(t => { tally[t] = (tally[t] || 0) + 1; });
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter(t => tally[t] === max && max > 0);

    let eliminated = null;
    if (top.length === 1 && top[0] !== 'nobody') {
      eliminated = getPlayer(top[0]);
      eliminated.alive = false;
      eliminated.causeOfDeath = 'vote';
      addLog(`The town voted out ${eliminated.name}. They were the ${ROLES[eliminated.role].name}.`, true);
    } else if (top.length > 1) {
      addLog('The vote was tied — no one was eliminated.');
    } else {
      addLog('The town chose to eliminate no one.');
    }

    G.announce = {
      kind: 'verdict',
      eliminatedName: eliminated ? eliminated.name : null,
      eliminatedRole: eliminated ? eliminated.role : null,
      tied: !eliminated && top.length > 1,
      forced: !!forced,
    };

    if (checkWin()) return;
    startNight();
  }

  function checkWin() {
    const mafia = aliveMafia().length;
    const town = alivePlayers().length - mafia;
    let winner = null;
    if (mafia === 0) winner = 'town';
    else if (mafia >= town) winner = 'mafia';
    if (winner) {
      G.phase = 'ended';
      G.winner = winner;
      addLog(winner === 'town'
        ? 'All mafia have been eliminated — the town wins! 🎉'
        : 'The mafia have taken over the town — the mafia win! 🔪', true);
      broadcast();
      return true;
    }
    return false;
  }

  function playAgain() {
    const keep = G.players.filter(p => p.connected);
    G = freshGame();
    G.players = keep.map(p => ({
      id: p.id, name: p.name, role: null, alive: true, connected: true, causeOfDeath: null,
    }));
    addLog('New game — waiting for the host to start.');
    broadcast();
  }

  function kickPlayer(id) {
    if (G.phase !== 'lobby') return;
    if (localConn && id === localConn._playerId) return; // the host can't kick themself
    const c = conns[id];
    if (c) { try { c.send({ t: 'error', fatal: true, msg: 'You were removed from the lobby by the host.' }); c.close(); } catch (e) {} }
    delete conns[id];
    G.players = G.players.filter(p => p.id !== id);
    broadcast();
  }

  /* ---------------- per-player state views ---------------- */

  function broadcast() {
    G.players.forEach(p => send(p.id, { t: 'state', view: viewFor(p) }));
    render();
  }

  function roleVisibleTo(viewer, target) {
    if (G.phase === 'ended') return true;
    if (!target.alive) return true;
    if (viewer && viewer.id === target.id) return true;
    if (viewer && viewer.role === 'mafia' && target.role === 'mafia' && G.phase !== 'lobby') return true;
    return false;
  }

  function viewFor(p) {
    const view = {
      roomCode,
      phase: G.phase,
      dayNum: G.dayNum,
      minPlayers: MIN_PLAYERS,
      winner: G.winner,
      announce: G.announce,
      roleSummary: G.players.length >= MIN_PLAYERS ? roleSummary(G.players.length) : null,
      you: {
        id: p.id, name: p.name, alive: p.alive,
        role: G.phase === 'lobby' ? null : p.role,
      },
      players: G.players.map(t => ({
        id: t.id, name: t.name, alive: t.alive, connected: t.connected,
        role: roleVisibleTo(p, t) && G.phase !== 'lobby' ? t.role : null,
        causeOfDeath: t.alive ? null : t.causeOfDeath,
      })),
    };

    if (G.phase === 'night' && p.alive) {
      const prompt = ROLES[p.role].nightPrompt;
      view.night = {
        acted: p.id in G.night.actions,
        actionTarget: G.night.actions[p.id] ? nameOf(G.night.actions[p.id]) : null,
        prompt,
        targets: prompt ? nightTargetsFor(p).map(t => ({ id: t.id, name: t.name })) : [],
        mates: p.role === 'mafia'
          ? aliveMafia().filter(m => m.id !== p.id).map(m => m.name)
          : null,
        waitingOn: nightActors().filter(a => !(a.id in G.night.actions)).length,
      };
    }

    if (G.phase === 'day') {
      const counts = {};
      Object.values(G.votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      view.vote = {
        yourVote: G.votes[p.id] || null,
        counts,
        voted: Object.keys(G.votes).length,
        needed: alivePlayers().length,
        targets: alivePlayers().filter(t => t.id !== p.id).map(t => ({ id: t.id, name: t.name })),
      };
    }

    return view;
  }

  /* ---------------- host controls UI ----------------
   * The host plays through the Player view above these controls, so this
   * panel shows only public information: counts, the code, and buttons. */

  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderFatal(msg) {
    const c = el('host-controls-area');
    if (c) c.innerHTML = `<div class="card center"><p class="error">${esc(msg)}</p></div>`;
  }

  function logHTML() {
    if (!G.log.length) return '';
    return `<div class="card"><h3>Game log</h3><div class="log">${
      G.log.slice(-30).map(e => `<div class="entry ${e.important ? 'important' : ''}">${esc(e.text)}</div>`).reverse().join('')
    }</div></div>`;
  }

  function render() {
    if (!G) return;
    const c = el('host-controls-area');
    if (!c) return;
    const joinURL = location.origin + location.pathname;

    let html = '';

    if (G.phase === 'lobby') {
      const n = G.players.length;
      html += `
        <div class="card room-code-box">
          <div class="muted small-text">Players join at</div>
          <div class="url">${esc(joinURL)}</div>
          <div class="muted small-text" style="margin-top:10px">with room code</div>
          <div class="code">${roomCode || '·····'}</div>
        </div>
        <div class="card">
          <div class="section-title"><h3>Host controls</h3>
            <span class="muted small-text">${n >= MIN_PLAYERS ? esc(roleSummary(n)) : `need ${MIN_PLAYERS - n} more`}</span></div>
          <div class="player-list">${G.players.map(p => `
            <div class="player-row">
              <span class="dot ${p.connected ? 'on' : 'off'}"></span>
              <span class="name">${esc(p.name)}${localConn && p.id === localConn._playerId ? ' (you)' : ''}</span>
              ${localConn && p.id === localConn._playerId ? '' : `<button class="btn small ghost" data-kick="${p.id}">✕</button>`}
            </div>`).join('')}</div>
          <button id="btn-start" class="btn primary big" style="margin-top:12px;width:100%" ${n < MIN_PLAYERS ? 'disabled' : ''}>
            ${n < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players` : `Start game with ${n} players`}
          </button>
          <p class="hint">You're playing too — the app runs the game and keeps everyone's role secret, including from you.</p>
        </div>`;
    }

    if (G.phase === 'night') {
      const pending = nightActors().filter(p => !(p.id in G.night.actions)).length;
      html += `
        <div class="card">
          <h3>Host controls</h3>
          <p class="muted small-text" style="margin:6px 0 10px">${
            pending === 0 ? 'Resolving the night…' : `Waiting for ${pending} player${pending > 1 ? 's' : ''} to act.`}</p>
          <button id="btn-force-night" class="btn" style="width:100%">⏭ End night now (skip missing actions)</button>
        </div>`;
    }

    if (G.phase === 'day') {
      html += `
        <div class="card">
          <h3>Host controls</h3>
          <p class="muted small-text" style="margin:6px 0 10px">Votes cast: ${Object.keys(G.votes).length}/${alivePlayers().length}.</p>
          <button id="btn-force-vote" class="btn" style="width:100%">⏭ End voting now (count votes cast)</button>
        </div>`;
    }

    if (G.phase === 'ended') {
      html += `
        <div class="card">
          <h3>Host controls</h3>
          <button id="btn-again" class="btn primary big" style="width:100%;margin-top:8px">Play again with connected players</button>
        </div>`;
    }

    html += logHTML();
    c.innerHTML = html;

    const on = (id, fn) => { const b = el(id); if (b) b.onclick = fn; };
    on('btn-start', startGame);
    on('btn-force-night', () => { if (confirm('End the night now? Players who haven’t acted will take no action.')) forceEndNight(); });
    on('btn-force-vote', () => { if (confirm('End voting now? Only votes already cast will count.')) forceEndVoting(); });
    on('btn-again', playAgain);
    c.querySelectorAll('[data-kick]').forEach(b => {
      b.onclick = () => kickPlayer(b.dataset.kick);
    });
  }

  return { create, destroy, PEER_PREFIX };
})();
