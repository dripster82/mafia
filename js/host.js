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
  let settings = { safeFirstNight: true, maxMafia: 0, showVoters: true, noSelfHeal: false, nightTimer: 120, dayTimer: 300 }; // survives new games
  let phaseTimer = null; // auto-advance timeout for the current phase

  /* Arm (or clear, with seconds=0) the current phase's auto-advance timer. */
  function setPhaseTimer(seconds, fn) {
    clearTimeout(phaseTimer);
    phaseTimer = null;
    G.deadline = seconds > 0 ? Date.now() + seconds * 1000 : null;
    if (seconds > 0) phaseTimer = setTimeout(fn, seconds * 1000);
  }

  /* ---------------- state ---------------- */

  function freshGame() {
    return {
      phase: 'lobby',      // lobby | reveal | night | day | ended
      dayNum: 0,
      confirms: {},        // reveal phase: playerId -> true once they've seen their role
      players: [],         // {id, name, role, alive, connected, causeOfDeath}
      night: null,         // {actions: {playerId: targetId}}
      votes: null,         // {playerId: targetId|'nobody'}
      announce: null,      // latest event to show players
      winner: null,
      chat: [],            // day-phase table talk, cleared each night
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

    peer = new Peer(PEER_PREFIX + roomCode, Object.assign({}, PEER_OPTS, window.MAFIA_PEER_CONFIG || {}));
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

  /* ---------------- bot players (for solo testing / filling seats) ----------------
   * Bots join through loopback connections like the host's own seat, get
   * dealt roles, and act on a short random delay. */

  const BOT_NAMES = ['Rita', 'Max', 'Ivy', 'Gus', 'Sal', 'Fay', 'Ned', 'Lou', 'Peg', 'Vic'];

  function addBot() {
    if (!G || G.phase !== 'lobby' || G.players.length >= 15) return;
    const name = BOT_NAMES.find(n => !G.players.some(p => p.name === n));
    if (!name) return;
    const conn = {
      open: true,
      _playerId: null,
      _pending: null,
      close() {},
      send(msg) {
        if (msg.t !== 'state') return;
        scheduleBot(conn);
      },
    };
    handleJoin(conn, { t: 'join', name });
    const bot = getPlayer(conn._playerId);
    if (bot) { bot.avatar = '🤖'; bot.isBot = true; broadcast(); }
  }

  const BOT_LINES = [
    'It wasn’t me, I promise!',
    'Hmm, {name} is being very quiet…',
    'I don’t trust {name} one bit.',
    'My money’s on {name}.',
    'Let’s not vote anyone out yet, it’s too early.',
    'Something about {name} feels off today.',
    'I was asleep all night, honest.',
    'Did anyone else notice {name} acting strange?',
    'We should think carefully before voting.',
    'I say we vote out {name} and be done with it.',
    '{name}, care to explain yourself?',
    'The mafia is definitely among us…',
  ];

  const rndOf = a => a[Math.floor(Math.random() * a.length)];

  /* One pending timer per bot. The delay is chosen for the CURRENT phase —
   * power-role night actions take 2-5s, everything else 1-3s — and if the
   * phase changes while waiting, the wait restarts, so a timer armed at the
   * end of one phase can never rush an action at the start of the next. */
  function scheduleBot(conn) {
    if (!G || conn._pending) return;
    const phase = G.phase;
    const p = getPlayer(conn._playerId);
    const isPowerNight = phase === 'night' && p && p.alive && ROLES[p.role] && ROLES[p.role].nightPrompt;
    const delay = isPowerNight ? 2000 + Math.random() * 3000 : 1000 + Math.random() * 2000;
    conn._pending = setTimeout(() => {
      conn._pending = null;
      if (!G) return;
      if (G.phase !== phase) { scheduleBot(conn); return; }
      botAct(conn);
    }, delay);
  }

  /* Role-aware table talk: bots use what they actually know. */
  function botLine(p) {
    const others = alivePlayers().filter(t => t.id !== p.id);
    const r = Math.random();

    if (p.role === 'detective' && p.intel && p.intel.length) {
      const mafiaKnown = p.intel.filter(i => { const t = getPlayer(i.targetId); return i.isMafia && t && t.alive; });
      const cleared = p.intel.filter(i => { const t = getPlayer(i.targetId); return !i.isMafia && t && t.alive; });
      if (mafiaKnown.length && r < 0.55) {
        const t = getPlayer(rndOf(mafiaKnown).targetId);
        return rndOf([
          `I'm the detective — ${t.name} is mafia. Vote them out!`,
          `Listen carefully: it's ${t.name}. I'd bet my badge on it.`,
          `I've been watching ${t.name} all night… it's them.`,
        ]);
      }
      if (cleared.length && r < 0.8) {
        const t = getPlayer(rndOf(cleared).targetId);
        return rndOf([
          `For what it's worth, I'm certain ${t.name} is innocent.`,
          `It's definitely not ${t.name} — let's look elsewhere.`,
          `Leave ${t.name} alone, they're clean. Trust me.`,
        ]);
      }
    }

    if (p.role === 'mafia') {
      const town = others.filter(t => t.role !== 'mafia');
      if (town.length && r < 0.7) {
        const t = rndOf(town);
        return rndOf([
          `${t.name} is acting really suspicious, if you ask me.`,
          `My money's on ${t.name}.`,
          `Did anyone else see ${t.name} hesitate? Just saying…`,
          `It's obviously ${t.name}. Who's with me?`,
        ]);
      }
      return rndOf(['It wasn’t me, I promise!', 'I was asleep all night, honest.', 'Let’s not rush this vote.']);
    }

    if (p.role === 'doctor' && G.announce && G.announce.kind === 'dawn' &&
        (G.announce.saved || G.announce.savedName) && r < 0.4) {
      return rndOf([
        'Lucky someone was watching over the town last night…',
        'Good thing nobody died, eh? 😉',
      ]);
    }

    const name = others.length ? rndOf(others).name : 'someone';
    return rndOf(BOT_LINES).replace('{name}', name);
  }

  function botAct(conn) {
    if (!G) return;
    const p = getPlayer(conn._playerId);
    if (!p || !p.alive) return;
    if (G.phase === 'reveal' && !G.confirms[p.id]) {
      handleConfirm(p);
    } else if (G.phase === 'night' && ROLES[p.role].nightPrompt && !(p.id in G.night.actions)) {
      const ts = nightTargetsFor(p);
      if (ts.length) handleNightAction(p, ts[Math.floor(Math.random() * ts.length)].id);
    } else if (G.phase === 'day') {
      // Talk first, vote on a later tick.
      if (conn._chatDay !== G.dayNum) {
        conn._chatDay = G.dayNum;
        handleChat(p, botLine(p));
        return;
      }
      if (!(p.id in G.votes)) {
        // Vote with what the bot knows: detectives go after confirmed mafia,
        // mafia push a townsperson, everyone else leans cautious.
        let target = null;
        if (p.role === 'detective' && p.intel) {
          const m = p.intel.map(i => getPlayer(i.targetId)).filter(t => t && t.alive && t.role === 'mafia');
          if (m.length) target = m[0].id;
        } else if (p.role === 'mafia') {
          const town = alivePlayers().filter(t => t.role !== 'mafia');
          target = (town.length && Math.random() < 0.8) ? rndOf(town).id : 'nobody';
        }
        if (!target) {
          const opts = alivePlayers().filter(t => t.id !== p.id).map(t => t.id);
          opts.push('nobody', 'nobody'); // lean toward sparing without evidence
          target = rndOf(opts);
        }
        handleVote(p, target);
      }
    }
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
    if (msg.t === 'profile') return handleProfile(p, msg);
    if (msg.t === 'confirm') return handleConfirm(p);
    if (msg.t === 'pickRole') return handlePickRole(p, msg.role);
    if (msg.t === 'chat') return handleChat(p, msg.text);
  }

  /* Table talk: lobby (waiting banter) and day (discussion). Only living
   * players may speak; everyone reads. */
  function handleChat(p, text) {
    if ((G.phase !== 'day' && G.phase !== 'lobby') || !p.alive) return;
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    G.chat.push({ name: p.name, avatar: p.avatar, text });
    if (G.chat.length > 100) G.chat = G.chat.slice(-100);
    broadcast();
  }

  /* Lobby-only: rename and avatar changes. */
  function handleProfile(p, msg) {
    if (G.phase !== 'lobby') return;
    if (msg.avatar && AVATARS.includes(msg.avatar)) {
      p.avatar = msg.avatar;
    }
    if (msg.name !== undefined) {
      const name = String(msg.name || '').trim().slice(0, 16);
      if (!name) {
        send(p.id, { t: 'toast', msg: 'Names can’t be empty.' });
      } else if (G.players.some(pl => pl.id !== p.id && pl.name.toLowerCase() === name.toLowerCase())) {
        send(p.id, { t: 'toast', msg: 'That name is taken — pick another.' });
      } else {
        p.name = name;
      }
    }
    broadcast();
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
        avatar: AVATARS[G.players.length % AVATARS.length],
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
    const deck = buildRoleDeck(G.players.length, settings.maxMafia);
    G.players.forEach((p, i) => { p.role = deck[i]; p.alive = true; });
    addLog(`Game started with ${G.players.length} players (${roleSummary(G.players.length, settings.maxMafia)}).`, true);
    G.phase = 'reveal';
    G.confirms = {};
    setPhaseTimer(0);
    broadcast();
  }

  /* True when p is the only human in the game — a solo test against bots. */
  function soloHuman(p) {
    return !p.isBot && G.players.every(pl => pl.id === p.id || pl.isBot);
  }

  /* Solo tests only: swap roles with a bot so the human can try any role. */
  function handlePickRole(p, roleId) {
    if (G.phase !== 'reveal' || G.confirms[p.id] || !soloHuman(p)) return;
    if (!ROLES[roleId] || p.role === roleId) return;
    const other = G.players.find(pl => pl.id !== p.id && pl.role === roleId);
    if (!other) return;
    other.role = p.role;
    p.role = roleId;
    broadcast();
  }

  function handleConfirm(p) {
    if (G.phase !== 'reveal' || G.confirms[p.id]) return;
    G.confirms[p.id] = true;
    if (G.players.every(pl => G.confirms[pl.id])) startNight();
    else broadcast();
  }

  function startNight() {
    G.dayNum += 1;
    G.phase = 'night';
    G.night = { actions: {} };
    G.votes = null;
    G.chat = [];
    setPhaseTimer(settings.nightTimer, () => { if (G && G.phase === 'night') resolveNight(true); });
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
      const isMafia = target.role === 'mafia';
      if (p.isBot) (p.intel = p.intel || []).push({ targetId, isMafia });
      send(p.id, { t: 'investigation', name: target.name, isMafia });
    }

    maybeResolveNight();
    broadcast();
  }

  function nightTargetsFor(p) {
    if (p.role === 'mafia') return alivePlayers().filter(t => t.role !== 'mafia');
    if (p.role === 'doctor') return alivePlayers().filter(t => !settings.noSelfHeal || t.id !== p.id);
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
    let savedName = null;
    let wounded = null;
    if (killTarget) {
      if (killTarget === savedId) {
        saved = true;
        // Only the first night reveals WHO the doctor saved.
        if (G.dayNum === 1) {
          savedName = getPlayer(killTarget).name;
          addLog(`${savedName} was attacked, but the doctor saved them!`, true);
        } else {
          addLog(`The mafia struck, but the doctor saved their target!`, true);
        }
      } else if (G.dayNum === 1 && settings.safeFirstNight) {
        wounded = getPlayer(killTarget);
        addLog(`${wounded.name} was wounded in the night, but survived!`, true);
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
      woundedName: wounded ? wounded.name : null,
      savedName,
      saved,
    };

    if (checkWin()) return;

    G.phase = 'day';
    G.votes = {};
    setPhaseTimer(settings.dayTimer, () => { if (G && G.phase === 'day') resolveVote(true); });
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

    // Elimination needs a strict majority of the votes cast, not a plurality.
    let eliminated = null;
    let noMajority = false;
    if (top.length === 1 && top[0] !== 'nobody') {
      if (max > cast.length / 2) {
        eliminated = getPlayer(top[0]);
        eliminated.alive = false;
        eliminated.causeOfDeath = 'vote';
        addLog(`The village ganged up on ${eliminated.name} (${max}/${cast.length} votes) — they were the ${ROLES[eliminated.role].name}.`, true);
      } else {
        noMajority = true;
        addLog('No majority was reached — no one was eliminated.');
      }
    } else if (top.length > 1) {
      addLog('The vote was tied — no one was eliminated.');
    } else {
      addLog('The town chose to eliminate no one.');
    }

    G.announce = {
      kind: 'verdict',
      eliminatedName: eliminated ? eliminated.name : null,
      eliminatedRole: eliminated ? eliminated.role : null,
      tied: !eliminated && !noMajority && top.length > 1,
      noMajority,
      forced: !!forced,
    };

    // Show the verdict to everyone for a few seconds before moving on.
    G.phase = 'verdict';
    setPhaseTimer(0);
    broadcast();
    setTimeout(() => {
      if (!G || G.phase !== 'verdict') return;
      if (checkWin()) return;
      startNight();
    }, 5000);
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
      setPhaseTimer(0);
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
    setPhaseTimer(0);
    G.players = keep.map(p => ({
      id: p.id, name: p.name, role: null, alive: true, connected: true, causeOfDeath: null,
      avatar: p.avatar, isBot: p.isBot,
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
      roleSummary: G.players.length >= MIN_PLAYERS ? roleSummary(G.players.length, settings.maxMafia) : null,
      settings: {
        safeFirstNight: settings.safeFirstNight, maxMafia: settings.maxMafia, showVoters: settings.showVoters,
        noSelfHeal: settings.noSelfHeal, nightTimer: settings.nightTimer, dayTimer: settings.dayTimer,
      },
      timer: G.deadline ? { deadline: G.deadline, hostNow: Date.now() } : null,
      you: {
        id: p.id, name: p.name, alive: p.alive, avatar: p.avatar,
        role: G.phase === 'lobby' ? null : p.role,
      },
      players: G.players.map(t => ({
        id: t.id, name: t.name, alive: t.alive, connected: t.connected, avatar: t.avatar,
        role: roleVisibleTo(p, t) && G.phase !== 'lobby' ? t.role : null,
        causeOfDeath: t.alive ? null : t.causeOfDeath,
      })),
    };

    if (G.phase === 'reveal') {
      view.reveal = {
        confirmed: !!G.confirms[p.id],
        waitingOn: G.players.filter(pl => !G.confirms[pl.id]).length,
        canPickRole: soloHuman(p),
      };
    }

    if (G.phase === 'night' && p.alive) {
      const prompt = ROLES[p.role].nightPrompt;
      view.night = {
        acted: p.id in G.night.actions,
        actionTarget: G.night.actions[p.id] ? nameOf(G.night.actions[p.id]) : null,
        prompt,
        targets: prompt ? nightTargetsFor(p).map(t => ({ id: t.id, name: t.name, avatar: t.avatar })) : [],
        mates: p.role === 'mafia'
          ? aliveMafia().filter(m => m.id !== p.id).map(m => ({
              name: m.name, avatar: m.avatar,
              pick: G.night.actions[m.id] ? nameOf(G.night.actions[m.id]) : null,
            }))
          : null,
        waitingOn: nightActors().filter(a => !(a.id in G.night.actions)).length,
      };
    }

    if (G.phase === 'lobby') {
      view.chat = G.chat.slice(-50);
      view.canChat = true;
    }

    if (G.phase === 'day') {
      const counts = {};
      const voters = {};
      Object.entries(G.votes).forEach(([voterId, t]) => {
        counts[t] = (counts[t] || 0) + 1;
        const v = getPlayer(voterId);
        (voters[t] = voters[t] || []).push(v.name);
      });
      view.vote = {
        yourVote: G.votes[p.id] || null,
        counts,
        voters: settings.showVoters ? voters : null,
        voted: Object.keys(G.votes).length,
        needed: alivePlayers().length,
        majority: Math.floor(alivePlayers().length / 2) + 1,
        targets: alivePlayers().filter(t => t.id !== p.id).map(t => ({ id: t.id, name: t.name, avatar: t.avatar })),
      };
      view.chat = G.chat.slice(-50);
      view.canChat = p.alive;
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
    let html = '';

    if (G.phase === 'lobby') {
      const n = G.players.length;
      html += `
        <div class="card room-code-box">
          <div class="muted small-text">Room code</div>
          <div class="code">${roomCode || '·····'}</div>
          ${roomCode ? App.qrSvgFor(roomCode) : ''}
          <div class="muted small-text">Scan to join, or open</div>
          <div class="url">${roomCode ? esc(App.joinLinkFor(roomCode)) : ''}</div>
        </div>
        <div class="card">
          <div class="section-title"><h3>Host controls</h3>
            <span class="muted small-text">${n >= MIN_PLAYERS ? esc(roleSummary(n, settings.maxMafia)) : `need ${MIN_PLAYERS - n} more`}</span></div>
          <div class="player-list">${G.players.map(p => `
            <div class="player-row">
              <span class="dot ${p.connected ? 'on' : 'off'}"></span>
              <span class="name">${p.avatar || ''} ${esc(p.name)}${localConn && p.id === localConn._playerId ? ' (you)' : ''}</span>
              ${localConn && p.id === localConn._playerId ? '' : `<button class="btn small ghost" data-kick="${p.id}">✕</button>`}
            </div>`).join('')}</div>
          <button id="btn-start" class="btn primary big" style="margin-top:12px;width:100%" ${n < MIN_PLAYERS ? 'disabled' : ''}>
            ${n < MIN_PLAYERS ? `Need at least ${MIN_PLAYERS} players` : `Start game with ${n} players`}
          </button>
          <button id="btn-add-bot" class="btn" style="margin-top:8px;width:100%">🤖 Add a bot player</button>
          <p class="hint">You're playing too — the app runs the game and keeps everyone's role secret, including from you.
          Bots fill empty seats so you can try the game solo; kick them with ✕ before a real game.</p>
        </div>
        <div class="card"><h3>Game options</h3>
          <label class="opt"><input type="checkbox" id="opt-safe-night" ${settings.safeFirstNight ? 'checked' : ''}>
            No deaths on the first night — the victim is only wounded</label>
          <label class="opt">Max mafia:
            <select id="opt-max-mafia">${[0, 1, 2, 3, 4].map(v =>
              `<option value="${v}" ${settings.maxMafia === v ? 'selected' : ''}>${v === 0 ? 'Auto' : v}</option>`).join('')}
            </select></label>
          <label class="opt"><input type="checkbox" id="opt-show-voters" ${settings.showVoters ? 'checked' : ''}>
            Show who voted for who (unticked = secret ballot)</label>
          <label class="opt"><input type="checkbox" id="opt-no-self-heal" ${settings.noSelfHeal ? 'checked' : ''}>
            Doctor can't protect themselves</label>
          <label class="opt">Night timer:
            <select id="opt-night-timer">${[[0, 'No limit'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']].map(([v, l]) =>
              `<option value="${v}" ${settings.nightTimer === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label class="opt">Discussion timer:
            <select id="opt-day-timer">${[[0, 'No limit'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']].map(([v, l]) =>
              `<option value="${v}" ${settings.dayTimer === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
        </div>`;
    }

    if (G.phase === 'reveal') {
      const pending = G.players.filter(p => !G.confirms[p.id]).length;
      html += `
        <div class="card">
          <h3>Host controls</h3>
          <p class="muted small-text" style="margin:6px 0 10px">Waiting for ${pending} player${pending === 1 ? '' : 's'} to confirm their role.</p>
          <button id="btn-force-reveal" class="btn" style="width:100%">⏭ Begin the first night now</button>
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
          <p class="muted small-text" style="margin:6px 0 10px">Votes cast: ${Object.keys(G.votes).length}/${alivePlayers().length}. A strict majority is needed to eliminate.</p>
          <button id="btn-force-vote" class="btn" style="width:100%">⏭ End voting now (count votes cast)</button>
        </div>`;
    }

    if (G.phase === 'verdict') {
      html += `<div class="card"><h3>Host controls</h3>
        <p class="muted small-text pulsing" style="margin-top:6px">⚖️ Verdict shown — night falls in a moment…</p></div>`;
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
    on('btn-add-bot', addBot);
    on('btn-force-reveal', () => { if (confirm('Begin the first night now, even though not everyone has confirmed?')) startNight(); });
    c.querySelectorAll('[data-kick]').forEach(b => {
      b.onclick = () => kickPlayer(b.dataset.kick);
    });
    const os = el('opt-safe-night');
    if (os) os.onchange = () => { settings.safeFirstNight = os.checked; broadcast(); };
    const om = el('opt-max-mafia');
    if (om) om.onchange = () => { settings.maxMafia = parseInt(om.value, 10) || 0; broadcast(); };
    const ov = el('opt-show-voters');
    if (ov) ov.onchange = () => { settings.showVoters = ov.checked; broadcast(); };
    const osh = el('opt-no-self-heal');
    if (osh) osh.onchange = () => { settings.noSelfHeal = osh.checked; broadcast(); };
    const ont = el('opt-night-timer');
    if (ont) ont.onchange = () => { settings.nightTimer = parseInt(ont.value, 10) || 0; broadcast(); };
    const odt = el('opt-day-timer');
    if (odt) odt.onchange = () => { settings.dayTimer = parseInt(odt.value, 10) || 0; broadcast(); };
  }

  return { create, destroy, PEER_PREFIX };
})();
