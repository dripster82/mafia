/* Host: authoritative game engine + operator UI.
 * The host device runs the game; players connect to it via WebRTC (PeerJS). */

const Host = (() => {
  const PEER_PREFIX = 'mafia-night-v1-';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O to avoid confusion

  let peer = null;
  let roomCode = null;
  let conns = {};   // playerId -> DataConnection
  let G = null;     // game state
  let showRoles = false;

  /* ---------------- state ---------------- */

  function freshGame() {
    return {
      phase: 'lobby',      // lobby | night | day | ended
      dayNum: 0,
      players: [],         // {id, name, role, alive, connected, causeOfDeath}
      night: null,         // {actions: {playerId: targetId}, resolved}
      votes: null,         // {playerId: targetId|'nobody'}
      announce: null,      // latest event to show players
      winner: null,
      log: [],
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

  function create() {
    roomCode = '';
    for (let i = 0; i < 5; i++) roomCode += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    G = freshGame();
    conns = {};

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
        create();
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

  function destroy() {
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; G = null; conns = {};
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
    if (p.role === 'detective') {
      const target = getPlayer(targetId);
      send(p.id, { t: 'investigation', name: target.name, isMafia: target.role === 'mafia' });
      addLog(`The detective investigated ${target.name}.`);
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

  /* ---------------- host UI ---------------- */

  const el = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderFatal(msg) {
    el('host-content').innerHTML = `<div class="card center"><p class="error">${esc(msg)}</p></div>`;
  }

  function playerRowHTML(p, opts = {}) {
    const roleKnown = showRoles || !p.alive || G.phase === 'ended';
    const role = p.role && roleKnown && G.phase !== 'lobby'
      ? `<span class="role-tag ${ROLES[p.role].team}">${ROLES[p.role].icon} ${ROLES[p.role].name}</span>` : '';
    const status = !p.alive
      ? `<span class="status">${p.causeOfDeath === 'vote' ? 'voted out' : 'killed'}</span>`
      : (opts.status || '');
    const kick = opts.kick ? `<button class="btn small ghost" data-kick="${p.id}">✕</button>` : '';
    return `<div class="player-row ${p.alive ? '' : 'dead'}">
      <span class="dot ${p.connected ? 'on' : 'off'}"></span>
      <span class="name">${esc(p.name)}</span>
      ${role} ${status} ${kick}
    </div>`;
  }

  function logHTML() {
    if (!G.log.length) return '';
    return `<div class="card"><h3>Game log</h3><div class="log">${
      G.log.slice(-30).map(e => `<div class="entry ${e.important ? 'important' : ''}">${esc(e.text)}</div>`).reverse().join('')
    }</div></div>`;
  }

  function rolesToggleHTML() {
    return `<button id="btn-toggle-roles" class="btn small ghost">${showRoles ? '🙈 Hide roles' : '👁 Reveal roles (operator only)'}</button>`;
  }

  function render() {
    if (!G) return;
    const c = el('host-content');
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
          <div class="section-title"><h3>Players (${n})</h3>
            <span class="muted small-text">${n >= MIN_PLAYERS ? esc(roleSummary(n)) : `need ${MIN_PLAYERS - n} more`}</span></div>
          <div class="player-list">${G.players.map(p => playerRowHTML(p, { kick: true })).join('') || '<p class="muted">Waiting for players to join…</p>'}</div>
        </div>
        <button id="btn-start" class="btn primary big" ${n < MIN_PLAYERS ? 'disabled' : ''}>
          ${n < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players` : `Start game with ${n} players`}
        </button>
        <p class="hint">The host is the neutral operator and doesn’t play. To play yourself, also join from another tab or device.</p>`;
    }

    if (G.phase === 'night') {
      const pending = nightActors().filter(p => !(p.id in G.night.actions));
      html += `
        <div class="banner night"><span class="big-emoji">🌙</span>
          <h2>Night ${G.dayNum}</h2>
          <p class="muted">${pending.length === 0 ? 'Resolving…' : `Waiting for ${pending.length} player${pending.length > 1 ? 's' : ''} to act…`}</p>
        </div>
        <div class="card">
          <div class="section-title"><h3>Players</h3>${rolesToggleHTML()}</div>
          <div class="player-list">${G.players.map(p => {
            const needsAct = p.alive && ROLES[p.role].nightPrompt;
            const done = p.id in G.night.actions;
            return playerRowHTML(p, { status: needsAct ? `<span class="status">${done ? '✅ done' : '⏳ acting'}</span>` : (p.alive ? '<span class="status">😴 asleep</span>' : '') });
          }).join('')}</div>
        </div>
        <button id="btn-force-night" class="btn warn">⏭ End night now (skip missing actions)</button>`;
    }

    if (G.phase === 'day') {
      const a = G.announce;
      html += `<div class="banner ${a && a.killedName ? 'death' : 'day'}"><span class="big-emoji">☀️</span>
        <h2>Day ${G.dayNum}</h2>
        <p>${a && a.killedName
          ? `<strong>${esc(a.killedName)}</strong> was killed in the night — they were the <strong>${ROLES[a.killedRole].name}</strong>.`
          : a && a.saved ? 'The mafia struck, but the doctor saved their target! No one died.' : 'No one died in the night.'}</p>
      </div>`;
      const counts = {};
      Object.values(G.votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      html += `
        <div class="card">
          <div class="section-title"><h3>Voting (${Object.keys(G.votes).length}/${alivePlayers().length})</h3>${rolesToggleHTML()}</div>
          <div class="player-list">${G.players.map(p => playerRowHTML(p, {
            status: p.alive ? `<span class="status">${p.id in G.votes ? '🗳 voted' : '…'}${counts[p.id] ? ` · ${counts[p.id]} vote${counts[p.id] > 1 ? 's' : ''} against` : ''}</span>` : '',
          })).join('')}</div>
          ${counts.nobody ? `<p class="muted small-text" style="margin-top:8px">🕊 ${counts.nobody} vote${counts.nobody > 1 ? 's' : ''} for no one</p>` : ''}
        </div>
        <button id="btn-force-vote" class="btn warn">⏭ End voting now (count votes cast)</button>`;
    }

    if (G.phase === 'ended') {
      html += `<div class="banner win"><span class="big-emoji">${G.winner === 'town' ? '🎉' : '🔪'}</span>
        <h2>${G.winner === 'town' ? 'The town wins!' : 'The mafia win!'}</h2>
        <p class="muted">All roles are now revealed.</p></div>
        <div class="card"><h3>Final roles</h3>
        <div class="player-list">${G.players.map(p => `
          <div class="player-row ${p.alive ? '' : 'dead'}">
            <span class="dot ${p.connected ? 'on' : 'off'}"></span>
            <span class="name">${esc(p.name)}</span>
            <span class="role-tag ${ROLES[p.role].team}">${ROLES[p.role].icon} ${ROLES[p.role].name}</span>
            <span class="status">${p.alive ? 'survived' : (p.causeOfDeath === 'vote' ? 'voted out' : 'killed')}</span>
          </div>`).join('')}</div></div>
        <button id="btn-again" class="btn primary big">Play again with connected players</button>`;
    }

    html += logHTML();
    c.innerHTML = html;

    // wire up controls
    const on = (id, fn) => { const b = el(id); if (b) b.onclick = fn; };
    on('btn-start', startGame);
    on('btn-force-night', () => { if (confirm('End the night now? Players who haven’t acted will take no action.')) forceEndNight(); });
    on('btn-force-vote', () => { if (confirm('End voting now? Only votes already cast will count.')) forceEndVoting(); });
    on('btn-again', playAgain);
    on('btn-toggle-roles', () => { showRoles = !showRoles; render(); });
    c.querySelectorAll('[data-kick]').forEach(b => {
      b.onclick = () => kickPlayer(b.dataset.kick);
    });
  }

  return { create, destroy, PEER_PREFIX };
})();
