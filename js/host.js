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
  let settings = {
    safeFirstNight: true, maxMafia: 1, showVoters: true, noSelfHeal: false,
    ghostVote: false,
    lastWords: true,     // eliminated players leave last words (the Forger needs this)
    showNightWaiting: true, // after 10s, name who the night is still waiting on
    publicGame: false,   // list this lobby on the join page's public directory
    revealOnDeath: true, // a dead player's role is made public (Coroner/Bookkeeper need it OFF)
    nightTimer: 120, dayTimer: 300,
    roles: { don: false, bodyguard: false, vigilante: false, watcher: false,
             tracker: false, coroner: false, bookkeeper: false, mayor: false,
             mortician: false, fixer: false, framer: false, poisoner: false,
             consigliere: false, forger: false, cleaner: false, recruiter: false,
             jester: false, executioner: false, drifter: false },
  };
  let phaseTimer = null; // auto-advance timeout for the current phase
  let lobbyBeacon = null; // periodic public-lobby announcement while listed
  let lastAnnounce = 0;   // throttle join/leave-triggered announcements
  let pendingAnnounce = null; // trailing announce when a change hits the throttle
  let voteCloseTimer = null; // short pause between the last vote and the verdict
  let hostPanelOpen = false; // in-game host panels fold away by default
  let verdictTimer = null;   // when the verdict screen moves on

  function deckOpts() {
    return { maxMafia: settings.maxMafia, roles: settings.roles };
  }

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
      phase: 'lobby',      // lobby | reveal | night | day | verdict | ended
      dayNum: 0,
      confirms: {},        // reveal phase: playerId -> true once they've seen their role
      players: [],
      night: null,         // {actions: {playerId: targetId|'skip'|pseudo}}
      votes: null,         // {playerId: targetId|'nobody'}
      announce: null,      // latest event to show players
      winner: null,
      lastWords: null,     // final message from a vote-eliminated player
      chat: [],            // lobby + day table talk, cleared each night
      // (suspicion lives per-bot on each player object: p.susp, p.heat)
      log: [],             // public information only — the host can read this
      deadline: null,
    };
  }

  function alivePlayers() { return G.players.filter(p => p.alive); }
  function teamOf(p) {
    if (p.recruited) return 'mafia';
    return p.role && ROLES[p.role] ? ROLES[p.role].team : 'town';
  }
  function aliveMafia() { return alivePlayers().filter(p => teamOf(p) === 'mafia'); }
  function killers() { return alivePlayers().filter(p => p.role === 'mafia' || p.role === 'don'); }
  function getPlayer(id) { return G.players.find(p => p.id === id); }
  function nameOf(id) { const p = getPlayer(id); return p ? p.name : '?'; }
  const rndOf = a => a[Math.floor(Math.random() * a.length)];

  function addLog(text, important) {
    G.log.push({ text, important: !!important });
  }

  /* Private dawn intelligence for one player. */
  function report(p, line) {
    send(p.id, { t: 'report', line: `Night ${G.dayNum}: ${line}` });
  }

  /* ---------------- lifecycle ---------------- */

  function create(name) {
    hostName = String(name || '').trim().slice(0, 16) || 'Host';
    roomCode = '';
    for (let i = 0; i < 5; i++) roomCode += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    G = freshGame();
    conns = {};

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
        peer.destroy();
        create(hostName);
      } else if (err.type !== 'peer-unavailable') {
        renderFatal('Connection error: ' + err.type + '. Refresh to try again.');
      }
    });
    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch (e) { /* destroyed */ }
    });
    startLobbyBeacon();
    render();
  }

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
    announcePublic(true);
    clearInterval(lobbyBeacon);
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; G = null; conns = {}; localConn = null;
  }

  /* Announce (or withdraw, with closing=true) this lobby on the public
   * directory. Best-effort: failures are silent — the game works without it. */
  function announcePublic(closing) {
    if (!G || !roomCode) return;
    if (!closing && (G.phase !== 'lobby' || !settings.publicGame)) return;
    if (closing && !settings.publicGame) return;
    lastAnnounce = Date.now();
    try {
      fetch(LOBBY_URL, {
        method: 'POST',
        body: JSON.stringify({
          code: roomCode,
          host: hostName,
          players: G.players.filter(p => p.connected).length,
          bots: G.players.filter(p => p.isBot).length,
          names: G.players.filter(p => p.connected && !p.isBot)
            .map(p => `${p.avatar || ''} ${p.name}`.trim()).slice(0, 8),
          closed: !!closing,
          ts: Date.now(),
        }),
      }).catch(() => {});
    } catch (e) {}
  }

  function startLobbyBeacon() {
    clearInterval(lobbyBeacon);
    lobbyBeacon = setInterval(() => announcePublic(), 25000);
  }

  // If the host's tab closes while publicly listed, withdraw the listing on
  // the way out (sendBeacon is built for unload); a hard crash still falls
  // back to the 90-second age-out on the join page.
  window.addEventListener('pagehide', () => {
    try {
      if (G && G.phase === 'lobby' && settings.publicGame && roomCode && navigator.sendBeacon) {
        navigator.sendBeacon(LOBBY_URL, JSON.stringify({ code: roomCode, closed: true, ts: Date.now() }));
      }
    } catch (e) {}
  });

  /* ---------------- crash/reload insurance ----------------
   * Every broadcast snapshots the whole game to localStorage; if the host's
   * browser reloads mid-game, the home screen offers to resume: same room
   * code, bots rebuilt, humans auto-reconnect from their own tabs. */

  const SNAPSHOT_KEY = 'mafia-host-snapshot';

  function saveSnapshot() {
    try {
      if (!G || G.phase === 'lobby' || G.phase === 'ended') { localStorage.removeItem(SNAPSHOT_KEY); return; }
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        v: 1, ts: Date.now(), roomCode, hostName, settings,
        localPlayerId: localConn ? localConn._playerId : null,
        detClaimants: [...(G.detClaimants || [])],
        G: Object.assign({}, G, { detClaimants: undefined }),
      }));
    } catch (e) { /* storage full/blocked — resume just won't be offered */ }
  }

  function snapshotInfo() {
    try {
      const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
      if (!s || s.v !== 1 || Date.now() - s.ts > 12 * 3600 * 1000) return null;
      return { roomCode: s.roomCode, hostName: s.hostName, phase: s.G.phase, dayNum: s.G.dayNum, ts: s.ts };
    } catch (e) { return null; }
  }

  function resume() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null'); } catch (e) {}
    if (!s || s.v !== 1) return false;

    hostName = s.hostName;
    roomCode = s.roomCode;
    settings = Object.assign({}, settings, s.settings);
    G = s.G;
    G.detClaimants = new Set(s.detClaimants || []);
    conns = {};

    document.getElementById('host-content').innerHTML =
      '<div id="host-player-area"></div><div id="host-controls-area"></div>';

    // The host's own seat loops straight back in.
    localConn = { open: true, send: msg => Player.receiveLocal(msg), close: () => {}, _playerId: s.localPlayerId };
    Player.initLocal(hostName, msg => handleMessage(localConn, msg));
    if (s.localPlayerId) {
      conns[s.localPlayerId] = localConn;
      const me = getPlayer(s.localPlayerId);
      if (me) me.connected = true;
    }

    // Bots get fresh loopback connections; humans reconnect from their tabs.
    G.players.filter(p => p.isBot).forEach(p => {
      const conn = {
        open: true, _playerId: p.id, _pending: null, _chatDay: G.dayNum,
        close() {},
        send(msg) { if (msg.t === 'state') scheduleBot(conn); },
      };
      conns[p.id] = conn;
      p.connected = true;
    });
    G.players.filter(p => !p.isBot && p.id !== s.localPlayerId).forEach(p => { p.connected = false; });

    peer = new Peer(PEER_PREFIX + roomCode, Object.assign({}, PEER_OPTS, window.MAFIA_PEER_CONFIG || {}));
    peer.on('open', () => {
      const pill = document.getElementById('host-room-pill');
      if (pill) pill.textContent = 'Room: ' + roomCode;
      render();
    });
    peer.on('connection', conn => {
      conn.on('data', msg => handleMessage(conn, msg));
      conn.on('close', () => handleDisconnect(conn));
      conn.on('error', () => handleDisconnect(conn));
    });
    peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        renderFatal('The old game is still open in another tab or window — close it, then resume again.');
      } else if (err.type !== 'peer-unavailable') {
        renderFatal('Connection error: ' + err.type + '. Refresh to try again.');
      }
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });

    // Re-arm whatever clock the phase was running on.
    const remaining = G.deadline ? Math.max(5, Math.round((G.deadline - Date.now()) / 1000)) : 0;
    if (G.phase === 'night' && remaining) setPhaseTimer(remaining, () => { if (G && G.phase === 'night') resolveNight(true); });
    else if (G.phase === 'day' && remaining) setPhaseTimer(remaining, () => { if (G && G.phase === 'day') resolveVote(true); });
    else if (G.phase === 'verdict') { G.lastWordsDone = true; scheduleVerdictEnd(8000); }
    if (G.phase === 'day') {
      G.voteClosing = false;
      G.lastChatAt = Date.now();
      setTimeout(() => { if (G && G.phase === 'day') maybeCloseVoting(); }, 1500);
    }

    addLog('The host reconnected — the game resumes.');
    startLobbyBeacon();
    broadcast();
    return true;
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
    if (msg.t === 'chat') return handleChat(p, msg.text, msg.chan);
    if (msg.t === 'lastWords') return handleLastWords(p, msg.text);
  }

  /* Table talk on three channels: 'main' (lobby banter + day discussion),
   * 'ghost' (the dead whisper in the same stream, visible only to the dead),
   * and 'mafia' (a private family channel, open day and night). */
  function handleChat(p, text, chan) {
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    if (!p.alive) chan = 'ghost';           // the dead can only whisper to each other
    else if (chan !== 'mafia') chan = 'main';
    if (chan === 'mafia' && (G.phase === 'lobby' || !p.role || teamOf(p) !== 'mafia')) return;
    const phaseOk = chan === 'mafia'
      ? (G.phase === 'day' || G.phase === 'night')
      : (G.phase === 'day' || G.phase === 'lobby');
    if (!phaseOk) return;
    G.chat.push(Object.assign({ name: p.name, avatar: p.avatar, text },
      p.isBot ? { bot: true } : {},
      chan === 'main' ? {} : { chan }));
    if (G.chat.length > 250) G.chat = G.chat.slice(-250);
    // Only public day talk sways the table (and holds the bots' votes open).
    if (G.phase === 'day' && chan === 'main') { G.lastChatAt = Date.now(); reactToChat(p, text); }
    broadcast();
  }

  /* Everyone at the table — bots included — listens to what gets said.
   * Accusations raise a player's suspicion score, defenses lower it, and a
   * detective claim carries extra weight. Bots use the scores to vote. */
  /* Each bot keeps its OWN opinion of every player, scaled by a personal
   * credulity factor — some bots are gullible, some skeptical. */
  function bumpFor(listener, targetId, amt) {
    if (!listener.isBot || listener.id === targetId) return;
    const v = Math.round(amt * (listener.credulity || 1)) || (amt > 0 ? 1 : -1);
    listener.susp = listener.susp || {};
    // Clamp so no one becomes an unshakeable pariah (or untouchable saint).
    listener.susp[targetId] = Math.max(-6, Math.min(10, (listener.susp[targetId] || 0) + v));
  }

  /* How accused a player themself is — drives self-defense, the mayor's
   * pledge, and the drifter's lying low. */
  function heatUp(target, amt) {
    target.heat = Math.max(0, Math.min(12, (target.heat || 0) + amt));
  }

  function suspOf(b, id) { return (b.susp || {})[id] || 0; }

  function reactToChat(speaker, text) {
    const lower = text.toLowerCase();
    const detClaim = /i'?m the detective|i am the detective|detective here|bet my badge/.test(lower);
    const defend = /innocent|not (the )?mafia|isn'?t (the )?mafia|it'?s not|it is not|definitely not|clean\b|trust (me|them)|leave .{1,20} alone|believe|save\b/.test(lower);
    const accuse = /mafia|suspicious|\bsus\b|guilty|lying|liar|lied|\blie\b|kill(er)?|vote (out|for|off)?|kick|eliminate|hang|lynch|it'?s |it is |i think|has to be|must be|money'?s on|watch|strange|acting|shady|off\b/.test(lower);

    // Anyone claiming to be the detective becomes a priority for both sides:
    // the mafia want them dead, the town wants them protected.
    if (detClaim) (G.detClaimants = G.detClaimants || new Set()).add(speaker.id);

    // "I've been poisoned!" — protective bots put the speaker first tonight.
    // (True or not: the doctor only learns what's said at the table.)
    if (/poison/.test(lower) && /\bi\b|\bme\b|i'?m|i'?ve/.test(lower)) {
      G.protectPriority = [speaker.id, ...(G.protectPriority || []).filter(id => id !== speaker.id)];
    }

    // Public record: any role claim is remembered — if someone else later dies
    // holding that role, the claimant is exposed as a liar.
    const claimMatch = lower.match(/i'?m the (detective|doctor|bodyguard|mayor|vigilante|watcher|tracker|coroner|bookkeeper|mortician)|i am the (detective|doctor|bodyguard|mayor|vigilante|watcher|tracker|coroner|bookkeeper|mortician)|(detective|doctor) here/);
    if (claimMatch) {
      (G.roleClaims = G.roleClaims || {})[speaker.id] = claimMatch[1] || claimMatch[2] || claimMatch[3];
    }

    const mentioned = [];
    const preMentioned = alivePlayers().filter(t => t.id !== speaker.id && lower.includes(t.name.toLowerCase()));

    // A false detective claim can draw out the real one.
    if (detClaim) maybeCounterClaim(speaker, preMentioned[0] || null);
    alivePlayers().forEach(t => {
      if (t.id === speaker.id) return;
      if (!lower.includes(t.name.toLowerCase())) return;
      mentioned.push(t);
      // Bot chatter counts for less than a human's word, so bots echoing each
      // other can't snowball one target — and every listening bot forms its
      // OWN opinion of what it just heard.
      const amt = defend ? (detClaim ? -4 : speaker.isBot ? -1 : -2)
                : accuse ? (detClaim ? 5 : speaker.isBot ? 1 : 2) : 0;
      if (amt) {
        alivePlayers().filter(b => b.isBot && b.id !== speaker.id).forEach(b => bumpFor(b, t.id, amt));
        if (amt > 0) heatUp(t, amt);
        // Remember who said what about whom — deaths re-read this record.
        const rec = { day: G.dayNum, speakerId: speaker.id, targetId: t.id, detClaim };
        if (amt > 0) (G.accusations = G.accusations || []).push(rec);
        else (G.defenses = G.defenses || []).push(rec);
      }
    });
    // Bots answer when spoken to (questions, greetings, or just their name).
    // A human addressing a bot almost always gets an answer; bot-to-bot
    // chatter stays throttled so they don't spiral.
    mentioned.filter(t => t.isBot && t.alive).forEach(bot => {
      if (accuse && !defend && !/\?/.test(lower)) return; // flat accusations get the defense path below
      if (Date.now() - (bot.lastReplyAt || 0) < (speaker.isBot ? 8000 : 4000)) return;
      if (Math.random() > (speaker.isBot ? 0.75 : 0.95)) return;
      bot.lastReplyAt = Date.now();
      setTimeout(() => {
        if (!G || G.phase !== 'day' || !bot.alive) return;
        handleChat(bot, botReplyTo(bot, lower));
      }, 1500 + Math.random() * 2500);
    });

    if (!mentioned.length || defend || !accuse) { maybeReconsiderVotes(); return; }

    // Accused bots defend themselves — reliably against a human's finger
    // (up to twice a day, the second time exasperated), less so to bot noise.
    mentioned.filter(t => t.isBot && t.alive).forEach(t => {
      if (/\?/.test(lower)) return; // questions were answered above, not defended against
      const n = t.defendCount && t.defendCount.day === G.dayNum ? t.defendCount.n : 0;
      if (n >= 2) return;
      if (Math.random() > (speaker.isBot ? 0.6 : 0.95)) return;
      t.defendCount = { day: G.dayNum, n: n + 1 };
      setTimeout(() => {
        if (!G || G.phase !== 'day' || !t.alive) return;
        const line = t.role === 'jester'
          ? rndOf(['Yes!! I mean… no? Definitely no. 😏', 'Guilty! Of being charming. Nothing else.'])
          : n === 0
            ? rndOf(['Whoa, why me? I’m innocent!', 'It wasn’t me, I swear!', 'You’re making a big mistake…', 'Me?! I’ve been helping this whole time!'])
            : rndOf(['I already TOLD you — it isn’t me.', 'Still on me? Fine. Vote, and see what it costs you.', 'Ask anyone. I’m clean. Look at who’s pointing instead.']);
        handleChat(t, line);
      }, 1500 + Math.random() * 2500);
    });

    // …and a detective claim can win a believer.
    if (detClaim && G.agreedDay !== G.dayNum) {
      const believers = alivePlayers().filter(b =>
        b.isBot && b.id !== speaker.id && !mentioned.some(m => m.id === b.id) && teamOf(b) !== 'mafia');
      if (believers.length && Math.random() < 0.5) {
        G.agreedDay = G.dayNum;
        const b = rndOf(believers);
        const accused = mentioned[0];
        setTimeout(() => {
          if (!G || G.phase !== 'day' || !b.alive || !accused.alive) return;
          handleChat(b, rndOf([
            `If the detective says it's ${accused.name}, that settles it for me.`,
            `Good enough for me — I'm voting ${accused.name}.`,
          ]));
        }, 2000 + Math.random() * 2500);
      }
    }
    maybeReconsiderVotes();
  }

  /* A revealed death makes every bot re-read the public record in hindsight:
   * a dead detective's accusations become gospel, a dead mafioso's words get
   * inverted, vote-blocs with the mafia look dirty, and anyone who claimed
   * the dead player's role stands exposed as a liar. */
  function reassessOnDeath(dead) {
    if (!settings.revealOnDeath) return; // roles stay secret — nothing to learn
    if (!dead || !dead.role || dead.cleaned) return; // cleaned bodies teach nothing
    const bots = G.players.filter(b => b.isBot && b.alive);
    if (!bots.length) return;
    const wasMafia = teamOf(dead) === 'mafia';
    const wasTown = !wasMafia && ROLES[dead.role].team === 'town';
    const wasDetective = dead.role === 'detective' && !dead.recruited;

    // 1) Re-weigh everything the dead player said.
    let gospelTarget = null;
    (G.accusations || []).filter(a => a.speakerId === dead.id).forEach(a => {
      const t = getPlayer(a.targetId);
      if (!t || !t.alive) return;
      if (wasDetective) {
        bots.forEach(b => bumpFor(b, t.id, a.detClaim ? 8 : 6)); // the dead detective's word is gospel
        gospelTarget = t;
      } else if (wasTown) {
        bots.forEach(b => bumpFor(b, t.id, 2));
      } else if (wasMafia) {
        bots.forEach(b => bumpFor(b, t.id, -3)); // mafia deflection — probably innocent
      }
    });
    if (wasMafia) {
      (G.defenses || []).filter(a => a.speakerId === dead.id).forEach(a => {
        const t = getPlayer(a.targetId);
        if (t && t.alive) bots.forEach(b => bumpFor(b, t.id, 3)); // whoever the mafia shielded…
      });
    }

    // 2) Re-read the vote record.
    if (wasDetective) {
      (G.voteHistory || []).forEach(dr => {
        const t = dr.votes[dead.id];
        if (t && t !== 'nobody') {
          const tp = getPlayer(t);
          if (tp && tp.alive) bots.forEach(b => bumpFor(b, t, 4));
        }
      });
    }
    if (wasMafia) {
      (G.voteHistory || []).forEach(dr => {
        const deadVote = dr.votes[dead.id];
        if (!deadVote || deadVote === 'nobody') return;
        Object.entries(dr.votes).forEach(([vid, tgt]) => {
          if (vid === dead.id || tgt !== deadVote) return;
          const v = getPlayer(vid);
          if (v && v.alive) bots.forEach(b => bumpFor(b, vid, 1)); // voted the mafia's line
        });
      });
    }
    if (wasTown) {
      // Those who campaigned against a proven townsperson look worse for it.
      (G.accusations || []).filter(a => a.targetId === dead.id).forEach(a => {
        const sp = getPlayer(a.speakerId);
        if (sp && sp.alive) { bots.forEach(b => bumpFor(b, sp.id, 2)); heatUp(sp, 1); }
      });
      if (dead.causeOfDeath === 'vote') {
        const last = (G.voteHistory || []).slice(-1)[0];
        if (last) {
          Object.entries(last.votes).forEach(([vid, tgt]) => {
            if (tgt !== dead.id) return;
            const v = getPlayer(vid);
            if (v && v.alive) bots.forEach(b => bumpFor(b, vid, 2));
          });
        }
      }
    }

    // 3) Exposed liars: someone else claimed the role this player really had.
    Object.entries(G.roleClaims || {}).forEach(([claimantId, roleId]) => {
      if (claimantId === dead.id || roleId !== dead.role) return;
      const liar = getPlayer(claimantId);
      if (!liar || !liar.alive) return;
      bots.forEach(b => bumpFor(b, liar.id, 6));
      heatUp(liar, 5);
      (G.pendingCallouts = G.pendingCallouts || []).push({
        kind: 'liar', liarId: liar.id, roleName: ROLES[dead.role].name, deadName: dead.name,
      });
    });

    // A dead detective's strongest lead gets picked up out loud.
    if (wasDetective && gospelTarget) {
      (G.pendingCallouts = G.pendingCallouts || []).push({
        kind: 'gospel', targetId: gospelTarget.id, deadName: dead.name,
      });
    }
  }

  /* At the next day's table, a bot voices what the deaths revealed. */
  function processCallouts() {
    const co = (G.pendingCallouts || []).splice(0, 2);
    co.forEach((c, i) => {
      setTimeout(() => {
        if (!G || G.phase !== 'day') return;
        const speakers = alivePlayers().filter(b => b.isBot && b.id !== c.liarId && teamOf(b) !== 'mafia');
        if (!speakers.length) return;
        const speaker = rndOf(speakers);
        if (c.kind === 'liar') {
          const liar = getPlayer(c.liarId);
          if (!liar || !liar.alive) return;
          handleChat(speaker, rndOf([
            `Hold on. ${c.deadName} was the REAL ${c.roleName}. ${liar.name}, you lied to all of us.`,
            `${c.deadName} turned out to be the ${c.roleName}… which makes ${liar.name}'s claim a flat lie. Interesting.`,
          ]));
        } else if (c.kind === 'gospel') {
          const t = getPlayer(c.targetId);
          if (!t || !t.alive) return;
          handleChat(speaker, rndOf([
            `${c.deadName} was the detective — and they suspected ${t.name}. I say we finish what they started.`,
            `Remember: ${c.deadName}, the real detective, pointed at ${t.name}. That's good enough for me.`,
          ]));
        }
      }, 3000 + i * 3500 + Math.random() * 2000);
    });
  }

  /* When someone claims detective and the REAL detective is a bot, the bot
   * knows they're lying. It either calls them out or quietly marks them. */
  function maybeCounterClaim(claimant, accused) {
    const realDet = alivePlayers().find(x => x.isBot && x.role === 'detective');
    if (!realDet || realDet.id === claimant.id) return;
    if (realDet.counterDay === G.dayNum) return;
    realDet.counterDay = G.dayNum;
    // If the liar happened to accuse someone the real detective KNOWS is
    // mafia, staying quiet and letting it ride is the smarter play.
    if (accused && realDet.intel && realDet.intel.some(i => i.targetId === accused.id && i.isMafia)) {
      bumpFor(realDet, claimant.id, 1);
      return;
    }
    if (Math.random() < 0.6) {
      const clearedAccused = accused && realDet.intel &&
        realDet.intel.some(i => i.targetId === accused.id && !i.isMafia);
      setTimeout(() => {
        if (!G || G.phase !== 'day' || !realDet.alive || !claimant.alive) return;
        handleChat(realDet, clearedAccused
          ? rndOf([
              `Lies. I am the detective, and I investigated ${accused.name} myself — they're clean. So what are you playing at, ${claimant.name}?`,
              `${claimant.name} is a fraud. The real detective — me — already cleared ${accused.name}.`,
            ])
          : rndOf([
              `${claimant.name} is lying — I'M the detective. And now I know exactly who to watch.`,
              `Interesting, ${claimant.name}… because the real detective is me. Care to explain yourself?`,
              `That's false. I am the detective — and ${claimant.name} just made my suspect list.`,
            ]));
      }, 2500 + Math.random() * 3000);
    } else {
      // Stays hidden, but the liar becomes their prime suspect.
      bumpFor(realDet, claimant.id, 3);
    }
  }

  /* What a bot says when directly addressed — consistent with how it votes. */
  function botReplyTo(bot, lower) {
    if (/\?|what do you think|who (do|should|is)|any ideas|thoughts/.test(lower)) {
      if (bot.role === 'detective' && bot.intel) {
        const m = bot.intel.map(i => getPlayer(i.targetId)).filter(t => t && t.alive && teamOf(t) === 'mafia');
        if (m.length) {
          bot.chatIntent = { day: G.dayNum, target: m[0].id };
          return rndOf([`Between us? Keep a very close eye on ${m[0].name}.`, `I have solid reasons to distrust ${m[0].name}.`]);
        }
      }
      // Answer with the target the bot actually intends to vote for.
      const ci = bot.chatIntent && bot.chatIntent.day === G.dayNum ? bot.chatIntent.target : null;
      let pick = ci && ci !== 'nobody' ? getPlayer(ci) : null;
      if (pick && !pick.alive) pick = null;
      if (!pick && ci !== 'nobody') {
        pick = botSuspicionPick(bot, 2);
        if (pick) bot.chatIntent = { day: G.dayNum, target: pick.id };
      }
      if (pick) {
        return rndOf([
          `Honestly? My money's on ${pick.name}.`,
          `If I had to guess: ${pick.name}.`,
          `Something's been off about ${pick.name} all day.`,
        ]);
      }
      return rndOf(['Too early to say.', 'I need more to go on — keep talking.', 'No idea yet. Watch the quiet ones.']);
    }
    if (/\b(hi|hello|hey|morning|yo)\b/.test(lower)) {
      return rndOf(['Hey 👋', 'Morning. Rough night, huh?', 'Hello there.', 'Yo. Trust no one.']);
    }

    // A statement aimed at the bot — engage with the substance.
    const mentionedOthers = alivePlayers().filter(t => t.id !== bot.id && lower.includes(t.name.toLowerCase()));
    if (mentionedOthers.length) {
      const m = rndOf(mentionedOthers);
      const sm = suspOf(bot, m.id);
      if (bot.role === 'detective' && bot.intel) {
        const rec = bot.intel.find(i => i.targetId === m.id);
        if (rec) {
          return rec.isMafia
            ? rndOf([`Funny you mention ${m.name}… my gut says you're onto something.`, `Keep talking about ${m.name}. You might be right.`])
            : rndOf([`${m.name}? No — I'd stake my badge they're clean.`, `You're wasting breath on ${m.name}. Look elsewhere.`]);
        }
      }
      if (teamOf(bot) === 'mafia' && teamOf(m) === 'mafia') {
        return rndOf([`${m.name}? Nah, I don't see it.`, `You're reaching — ${m.name} is harmless.`, `${m.name}? They can barely stay awake, let alone kill.`]);
      }
      if (sm >= 2) {
        return rndOf([`${m.name}? Honestly… could be. They've been twitchy.`, `I've had my eye on ${m.name} too.`, `Go on — what exactly did ${m.name} do?`]);
      }
      if (sm <= -2) {
        return rndOf([`${m.name} seems clean to me.`, `I don't buy ${m.name} being involved.`]);
      }
      return rndOf([`${m.name}… I hadn't considered them. Tell me more.`, `What makes you say ${m.name}?`, `Hmm, ${m.name}. I'll be watching them today.`]);
    }

    // No names in it — answer with an actual opinion, not a shrug.
    const ci2 = bot.chatIntent && bot.chatIntent.day === G.dayNum ? bot.chatIntent.target : null;
    const lean = ci2 && ci2 !== 'nobody' ? getPlayer(ci2) : null;
    if (lean && lean.alive) {
      return rndOf([
        `All I know is ${lean.name} keeps dodging questions.`,
        `For the record, my vote's leaning ${lean.name}.`,
        `While we're all talking, ${lean.name} has said remarkably little…`,
      ]);
    }
    if (bot.role === 'jester') {
      return rndOf(['Fascinating. Anyway, has anyone considered voting ME? Just spitballing.', 'Love the chaos. More of this please.']);
    }
    return rndOf([
      `${alivePlayers().length} of us left, and at least one is lying through their teeth.`,
      'Watch who talks the most… and who says nothing at all.',
      'The quiet ones worry me more than the loud ones.',
      'I’ve been counting votes all day. Something doesn’t add up.',
      'Nobody leaves this table until we figure this out.',
    ]);
  }

  /* A suspicious valid target for a bot — weighted-random among everyone over
   * the threshold (not always the single leader), and occasionally a fresh
   * hunch about someone nobody is watching, so no player gets ignored. */
  function botSuspicionPick(b, minScore) {
    const cands = alivePlayers().filter(t =>
      t.id !== b.id && !(teamOf(b) === 'mafia' && teamOf(t) === 'mafia'));
    if (!cands.length) return null;
    const hot = cands.filter(t => suspOf(b, t.id) >= (minScore || 2));
    if (!hot.length) return null;
    // 15% of the time, look past the noise at an unwatched player instead.
    const cold = cands.filter(t => suspOf(b, t.id) <= 0);
    if (cold.length && Math.random() < 0.15) return rndOf(cold);
    // Otherwise pick weighted by score, so runners-up still draw attention.
    const total = hot.reduce((s, t) => s + suspOf(b, t.id), 0);
    let roll = Math.random() * total;
    for (const t of hot) {
      roll -= suspOf(b, t.id);
      if (roll <= 0) return t;
    }
    return hot[hot.length - 1];
  }

  /* Bots that already voted may switch when the mood turns hard. */
  function maybeReconsiderVotes() {
    alivePlayers().filter(b => b.isBot && b.id in (G.votes || {})).forEach(b => {
      if (b.reconsideredDay === G.dayNum || Math.random() > 0.5) return;
      b.reconsideredDay = G.dayNum;
      setTimeout(() => {
        if (!G || G.phase !== 'day' || !b.alive || !(b.id in G.votes)) return;
        const pick = botSuspicionPick(b, 4);
        if (pick && G.votes[b.id] !== pick.id) {
          // Say so before switching, so chat and votes stay in step.
          b.chatIntent = { day: G.dayNum, target: pick.id };
          handleVote(b, pick.id);
          if (Math.random() < 0.6) {
            handleChat(b, rndOf([
              `Changed my mind — it's ${pick.name}.`,
              `Actually… I'm switching my vote to ${pick.name}.`,
            ]));
          }
        }
      }, 1500 + Math.random() * 3000);
    });
  }

  function handleJoin(conn, msg) {
    const name = String(msg.name || '').trim().slice(0, 16);
    if (!name) { conn.send({ t: 'error', fatal: true, msg: 'Please enter a name.' }); return; }

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
      if (G.players.some(pl => pl.name.toLowerCase() === name.toLowerCase())) {
        conn.send({ t: 'error', fatal: true, msg: 'That name is taken — pick another.' });
        return;
      }
      const midGame = G.phase !== 'lobby';
      p = {
        id: 'p' + Math.random().toString(36).slice(2, 10),
        name, role: null, alive: !midGame, connected: true, causeOfDeath: null,
        avatar: AVATARS[G.players.length % AVATARS.length],
        spectator: midGame,
      };
      G.players.push(p);
      if (midGame) addLog(`${name} joined as a spectator.`);
    }

    p.connected = true;
    conn._playerId = p.id;
    conns[p.id] = conn;
    conn.send({ t: 'joined', playerId: p.id, roomCode });
    broadcast();
  }

  /* Lobby-only: rename and avatar changes. */
  function handleProfile(p, msg) {
    if (G.phase !== 'lobby') return;
    if (msg.avatar && AVATARS.includes(msg.avatar)) {
      p.avatar = msg.avatar;
      // Humans have first claim on a face — a bot wearing it picks a new one.
      G.players.filter(b => b.isBot && b.id !== p.id && b.avatar === p.avatar).forEach(b => {
        const used = new Set(G.players.map(x => x.avatar));
        const free = AVATARS.filter(a => !used.has(a));
        if (free.length) b.avatar = rndOf(free);
      });
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

  /* ---------------- game flow ---------------- */

  function startGame() {
    const connected = G.players.filter(p => p.connected);
    if (connected.length < MIN_PLAYERS) return;
    G.players = connected;
    const deck = buildRoleDeck(G.players.length, deckOpts());
    G.players.forEach((p, i) => {
      p.role = deck[i]; p.alive = true;
      p.bullets = 2; p.guilt = false; p.usedRaise = false;
      p.forgerUses = 2; p.cleanerUses = 2; p.recruiterUsed = false;
      p.drifterUses = 2; p.pledged = false; p.poisonedNight = null;
      p.cleaned = false; p.forged = false; p.recruited = false;
      p.execTargetId = null; p.achievedWin = false; p.lostWin = false;
      p.ghostVoteUsed = false; p.defendedDay = 0; p.reconsideredDay = 0; p.chatIntent = null;
      p.susp = {}; p.heat = 0; p.credulity = 0.6 + Math.random() * 0.8; // gullible ↔ skeptical
      p.actions = []; p.intel = [];
      // Every bot gets a temperament that shapes how it talks and votes.
      if (p.isBot) {
        p.persona = rndOf(['accuser', 'analyst', 'sheep', 'contrarian', 'showman']);
        p.credulity = {
          accuser: 1.1 + Math.random() * 0.3,     // quick to believe the worst
          analyst: 0.6 + Math.random() * 0.2,     // needs evidence
          sheep: 1.2 + Math.random() * 0.2,       // swallows the room's mood
          contrarian: 0.6 + Math.random() * 0.3,  // doubts whatever's popular
          showman: 0.8 + Math.random() * 0.4,
        }[p.persona];
      }
    });
    G.gameId = 'g' + Math.random().toString(36).slice(2, 10);
    hostPanelOpen = false; // fresh game, panels folded again
    // Each executioner gets a personal grudge against a random townsperson.
    G.players.filter(p => p.role === 'executioner').forEach(ex => {
      const towns = G.players.filter(t => t.id !== ex.id && ROLES[t.role].team === 'town');
      if (towns.length) ex.execTargetId = rndOf(towns).id;
    });
    addLog(`Game started with ${G.players.length} players (${roleSummary(G.players.length, deckOpts())}).`, true);
    announcePublic(true); // withdraw the lobby from the public directory
    G.phase = 'reveal';
    G.confirms = {};
    setPhaseTimer(0);
    broadcast();
  }

  function soloHuman(p) {
    return !p.isBot && G.players.every(pl => pl.id === p.id || pl.isBot);
  }

  function handlePickRole(p, roleId) {
    if (G.phase !== 'reveal' || G.confirms[p.id] || !soloHuman(p)) return;
    if (!ROLES[roleId] || p.role === roleId) return;
    const other = G.players.find(pl => pl.id !== p.id && pl.role === roleId);
    if (!other) return;
    other.role = p.role;
    p.role = roleId;
    // Re-target any executioner involved in the swap.
    G.players.filter(x => x.role === 'executioner').forEach(ex => {
      const towns = G.players.filter(t => t.id !== ex.id && ROLES[t.role].team === 'town');
      if (towns.length && (!ex.execTargetId || !towns.some(t => t.id === ex.execTargetId))) {
        ex.execTargetId = rndOf(towns).id;
      }
    });
    broadcast();
  }

  function handleConfirm(p) {
    if (G.phase !== 'reveal' || G.confirms[p.id]) return;
    G.confirms[p.id] = true;
    if (G.players.filter(pl => !pl.spectator).every(pl => G.confirms[pl.id])) startNight();
    else broadcast();
  }

  function startNight() {
    G.dayNum += 1;
    G.phase = 'night';
    G.night = { actions: {} };
    G.votes = null;
    // Chat history survives the night — a divider marks where the new round starts.
    G.chat.push({ divider: `Round ${G.dayNum}` });
    // Yesterday's accusations fade, but aren't forgotten.
    G.players.forEach(x => {
      if (x.susp) Object.keys(x.susp).forEach(k => { x.susp[k] = Math.round(x.susp[k] / 2); });
      x.heat = Math.floor((x.heat || 0) / 2);
    });
    setPhaseTimer(settings.nightTimer, () => { if (G && G.phase === 'night') resolveNight(true); });
    addLog(`Night ${G.dayNum} falls. The town sleeps.`);
    // A 10s grace before naming the slow ones — then re-broadcast to reveal.
    G.nightStartedAt = Date.now();
    if (settings.showNightWaiting) {
      const night = G.dayNum;
      setTimeout(() => { if (G && G.phase === 'night' && G.dayNum === night) broadcast(); }, 10500);
    }
    broadcast();
  }

  /* What (if anything) this player decides tonight. Null = they sleep. */
  function nightUIFor(p) {
    if (!p.alive || p.spectator) return null;
    const others = alivePlayers().filter(t => t.id !== p.id);
    const nonMafia = alivePlayers().filter(t => teamOf(t) !== 'mafia');
    const deadBodies = G.players.filter(t => !t.alive && !t.spectator && t.role);
    // Mafia-team players see who's already been poisoned when picking targets.
    const seesPoison = p.role && teamOf(p) === 'mafia';
    const mk = list => list.map(t => ({
      id: t.id, avatar: t.avatar,
      name: t.name + (seesPoison && t.alive && t.poisonedNight !== null ? ' ☠️' : ''),
    }));
    const r = p.role;

    if (r === 'mafia' || r === 'don') {
      return { prompt: 'Choose someone to eliminate tonight', targets: mk(nonMafia), canSkip: true, skipLabel: '🕊 Make no kill tonight' };
    }
    if (r === 'doctor') {
      const ts = alivePlayers().filter(t => !settings.noSelfHeal || t.id !== p.id);
      return { prompt: 'Choose someone to protect tonight', targets: mk(ts) };
    }
    if (r === 'detective') return { prompt: 'Choose someone to investigate tonight', targets: mk(others) };
    if (r === 'vigilante') {
      if (G.dayNum < 2 || p.bullets <= 0 || p.guilt) return null;
      return { prompt: `Shoot someone (${p.bullets} bullet${p.bullets > 1 ? 's' : ''} left) — or hold your fire`, targets: mk(others), canSkip: true, skipLabel: '🕊 Hold your fire' };
    }
    if (r === 'mortician') {
      if (p.usedRaise) return null;
      const raisable = deadBodies.filter(t => ROLES[t.role].team === 'town');
      if (!raisable.length) return null;
      return { prompt: 'Raise a fallen villager at dawn — or wait', targets: mk(raisable), canSkip: true, skipLabel: '⏳ Wait — save your power' };
    }
    if (r === 'watcher') return { prompt: 'Choose whose door to watch tonight', targets: mk(others) };
    if (r === 'bodyguard') return { prompt: 'Choose someone to guard tonight', targets: mk(others) };
    if (r === 'tracker') return { prompt: 'Choose someone to follow tonight', targets: mk(others) };
    if (r === 'coroner') {
      if (!deadBodies.length) return null;
      return { prompt: 'Choose a body to examine tonight', targets: mk(deadBodies), canSkip: true, skipLabel: '🚪 Leave the morgue' };
    }
    if (r === 'mayor') {
      if (p.pledged) return null;
      return { prompt: 'Go public — or stay quiet', targets: [{ id: 'pledge', name: '📣 Pledge — go public at dawn', avatar: '' }], canSkip: true, skipLabel: '🤫 Stay quiet' };
    }
    if (r === 'fixer') return { prompt: 'Choose whose night action to prevent', targets: mk(nonMafia.filter(t => t.id !== p.id)), canSkip: true, skipLabel: 'Do nothing tonight' };
    if (r === 'framer') return { prompt: 'Choose someone to frame tonight', targets: mk(nonMafia.filter(t => t.id !== p.id)), canSkip: true, skipLabel: 'Do nothing tonight' };
    if (r === 'poisoner') return { prompt: 'Choose someone to poison tonight', targets: mk(nonMafia.filter(t => t.id !== p.id)), canSkip: true, skipLabel: 'Do nothing tonight' };
    if (r === 'consigliere') return { prompt: 'Choose someone to investigate tonight', targets: mk(nonMafia.filter(t => t.id !== p.id)), canSkip: true, skipLabel: 'Do nothing tonight' };
    if (r === 'forger') {
      if (p.forgerUses <= 0) return null;
      return { prompt: `Mark someone’s last words for destruction (${p.forgerUses} left) — or wait`, targets: mk(nonMafia.filter(t => t.id !== p.id && !t.forged)), canSkip: true, skipLabel: '⏳ Wait' };
    }
    if (r === 'cleaner') {
      if (p.cleanerUses <= 0) return null;
      return { prompt: `Clean tonight’s kill (${p.cleanerUses} left) — or wait`, targets: [{ id: 'clean', name: '🧹 Clean tonight’s kill', avatar: '' }], canSkip: true, skipLabel: '⏳ Wait' };
    }
    if (r === 'recruiter') {
      if (p.recruiterUsed || G.dayNum < 2) return null;
      return { prompt: 'Turn a villager instead of killing tonight — or wait', targets: mk(nonMafia.filter(t => t.id !== p.id)), canSkip: true, skipLabel: '⏳ Not tonight' };
    }
    if (r === 'drifter') {
      if (p.drifterUses <= 0) return null;
      return { prompt: `Lie low tonight? (${p.drifterUses} left)`, targets: [{ id: 'hide', name: '🎒 Lie low — nothing can touch you', avatar: '' }], canSkip: true, skipLabel: '😴 Sleep normally' };
    }
    return null;
  }

  function nightActors() {
    return alivePlayers().filter(p => nightUIFor(p) !== null);
  }

  function handleNightAction(p, targetId) {
    if (G.phase !== 'night') return;
    const ui = nightUIFor(p);
    if (!ui) return;
    const isSkip = targetId === 'skip';
    if (isSkip && !ui.canSkip) return;
    if (!isSkip && !ui.targets.some(t => t.id === targetId)) return;
    G.night.actions[p.id] = targetId;

    const pseudo = targetId === 'pledge' || targetId === 'hide' || targetId === 'clean';
    (p.actions = p.actions || []).push({
      night: G.dayNum, role: p.role,
      target: (isSkip || pseudo) ? null : nameOf(targetId),
      skip: isSkip, special: pseudo ? targetId : null,
      result: null,
    });

    maybeResolveNight();
    broadcast();
  }

  function maybeResolveNight() {
    const pending = nightActors().filter(p => !(p.id in G.night.actions));
    if (pending.length === 0) resolveNight();
  }

  function forceEndNight() { resolveNight(true); }

  function resolveNight(forced) {
    if (G.phase !== 'night') return;
    const A = G.night.actions;
    const visits = []; // {visitor, target}
    const recapResult = (p, text) => {
      const last = (p.actions || []).filter(a => a.night === G.dayNum).pop();
      if (last) last.result = text;
    };

    // 1. Fixer blocks (mafia-team, unblockable themselves).
    const blocked = new Set();
    alivePlayers().filter(p => p.role === 'fixer').forEach(f => {
      const t = A[f.id];
      if (t && t !== 'skip') { blocked.add(t); visits.push({ visitor: f.id, target: t }); }
    });
    const eff = p => blocked.has(p.id) ? undefined : A[p.id];

    // 2. Drifter immunity.
    const immune = new Set();
    alivePlayers().filter(p => p.role === 'drifter').forEach(d => {
      if (eff(d) === 'hide') { immune.add(d.id); d.drifterUses--; }
    });

    // 3. Framing (applies to tonight's investigations).
    const framed = new Set();
    alivePlayers().filter(p => p.role === 'framer').forEach(f => {
      const t = eff(f);
      if (t && t !== 'skip') { framed.add(t); visits.push({ visitor: f.id, target: t }); }
    });

    // 4. Protection.
    let savedId = null;
    alivePlayers().filter(p => p.role === 'doctor').forEach(d => {
      const t = eff(d);
      if (t && t !== 'skip') { savedId = t; visits.push({ visitor: d.id, target: t }); }
    });
    const guards = {}; // targetId -> bodyguard
    alivePlayers().filter(p => p.role === 'bodyguard').forEach(b => {
      const t = eff(b);
      if (t && t !== 'skip') { guards[t] = b; visits.push({ visitor: b.id, target: t }); }
    });

    // 5. Mafia kill vote (killers only; recruiter's offer replaces the kill).
    const mafiaPicks = killers().map(m => A[m.id]).filter(t => t && t !== 'skip');
    let killTarget = null;
    if (mafiaPicks.length) {
      const tally = {};
      mafiaPicks.forEach(t => { tally[t] = (tally[t] || 0) + 1; });
      const max = Math.max(...Object.values(tally));
      killTarget = rndOf(Object.keys(tally).filter(t => tally[t] === max));
    }

    // Recruiter: turning someone cancels the family's kill tonight.
    let recruitedName = null;
    alivePlayers().filter(p => p.role === 'recruiter' && !p.recruiterUsed).forEach(rc => {
      const t = eff(rc);
      if (t && t !== 'skip' && G.dayNum >= 2) {
        const target = getPlayer(t);
        if (target && target.alive && teamOf(target) !== 'mafia') {
          rc.recruiterUsed = true;
          target.recruited = true;
          killTarget = null;
          recruitedName = target.name;
          visits.push({ visitor: rc.id, target: t });
          report(target, '🤝 The mafia made you an offer you couldn’t refuse. You are now on their side — you win with the mafia. Nobody else knows.');
          report(rc, `🤝 ${target.name} accepted the offer. They're one of ours now.`);
          recapResult(rc, `recruited ${target.name}`);
        }
      }
    });

    if (killTarget) {
      const voter = rndOf(killers().filter(m => A[m.id] === killTarget));
      if (voter) visits.push({ visitor: voter.id, target: killTarget });
    }

    // 6. Vigilante shots.
    const shots = []; // {shooter, target}
    alivePlayers().filter(p => p.role === 'vigilante').forEach(v => {
      const t = eff(v);
      if (t && t !== 'skip' && G.dayNum >= 2 && v.bullets > 0 && !v.guilt) {
        v.bullets--;
        shots.push({ shooter: v, target: t });
        visits.push({ visitor: v.id, target: t });
      }
    });

    // 7. Resolve attacks.
    const deaths = new Map(); // id -> cause
    let saved = false;
    const guardSaves = []; // guards who took the hit but were saved by the doctor
    const attack = (targetId, cause, guardable) => {
      if (immune.has(targetId)) return;
      if (targetId === savedId) { saved = true; return; }
      const guard = guardable ? guards[targetId] : null;
      if (guard && guard.alive) {
        if (guard.id === savedId) { saved = true; guardSaves.push({ guard, targetId }); return; }
        deaths.set(guard.id, 'guard');
        return;
      }
      deaths.set(targetId, cause);
    };
    if (killTarget) attack(killTarget, 'mafia', true);
    shots.forEach(s => attack(s.target, 'vigilante', false));

    // 8. New poisons + pending poison deaths.
    alivePlayers().filter(p => p.role === 'poisoner').forEach(po => {
      const t = eff(po);
      if (t && t !== 'skip') {
        const target = getPlayer(t);
        if (target && target.alive) {
          target.poisonedNight = G.dayNum;
          visits.push({ visitor: po.id, target: t });
          // The victim knows — nobody else is told until the body drops.
          report(target, '☠️ You feel deathly ill — you have been POISONED. Unless the doctor heals you tomorrow night, you will die at dawn.');
        }
      }
    });
    let curedName = null;
    alivePlayers().forEach(p => {
      if (p.poisonedNight !== null && p.poisonedNight === G.dayNum - 1 && !deaths.has(p.id)) {
        if (p.id === savedId) {
          p.poisonedNight = null;
          curedName = p.name;
          report(p, '💊 You woke feeling terrible — the doctor pulled you back from the brink.');
        }
        else if (!immune.has(p.id)) deaths.set(p.id, 'poison');
      }
    });

    // 9. Apply deaths (safe first night wounds instead, poison excepted).
    const killed = [];
    const woundedNames = [];
    const woundedIds = [];
    deaths.forEach((cause, id) => {
      const victim = getPlayer(id);
      if (G.dayNum === 1 && settings.safeFirstNight && cause !== 'poison') {
        woundedNames.push(victim.name);
        woundedIds.push(id);
        if (cause === 'guard') report(victim, '🛡 You were hurt shielding your charge last night.');
        return;
      }
      victim.alive = false;
      victim.causeOfDeath = cause;
      killed.push({ id, name: victim.name, role: victim.role, cause });
    });
    // Survivors of an attack are likely to be attacked again — protective
    // bots (doctor, bodyguard) prioritize them next night.
    G.protectPriority = [...(saved && savedId ? [savedId] : []), ...woundedIds];

    // 10. Cleaner hides the family victim's role.
    alivePlayers().filter(p => p.role === 'cleaner' && p.cleanerUses > 0).forEach(c => {
      if (eff(c) === 'clean') {
        const k = killed.find(x => x.cause === 'mafia');
        if (k) {
          c.cleanerUses--;
          getPlayer(k.id).cleaned = true;
          report(c, `🧹 You cleaned the scene. ${k.name} was the ${ROLES[k.role].name} — only you know.`);
          recapResult(c, `cleaned ${k.name}'s body`);
          k.role = null; // public announcement shows no role
        }
      }
    });

    // 11. Forger marks.
    alivePlayers().filter(p => p.role === 'forger' && p.forgerUses > 0).forEach(f => {
      const t = eff(f);
      if (t && t !== 'skip') {
        const target = getPlayer(t);
        if (target && !target.forged) {
          f.forgerUses--;
          target.forged = true;
          report(f, `✒️ Prepared a forgery for ${target.name}'s last words.`);
        }
      }
    });

    // 12. Mortician revival (bodies from before tonight). The ritual was
    // performed during the night, so it completes even if the mortician was
    // killed tonight — a dying breath still raises the dead.
    let revivedName = null;
    G.players.filter(p => p.role === 'mortician' && !p.usedRaise && !p.spectator).forEach(m => {
      const t = eff(m);
      if (t && t !== 'skip') {
        const body = getPlayer(t);
        if (body && !body.alive && !killed.some(k => k.id === t) && ROLES[body.role] && ROLES[body.role].team === 'town') {
          m.usedRaise = true;
          body.alive = true;
          body.causeOfDeath = null;
          body.poisonedNight = null;
          revivedName = body.name;
          report(body, '⚰️ You gasp awake — the Mortician has raised you from the dead!');
          recapResult(m, `raised ${body.name} from the dead`);
        } else {
          // Never silent: a raise that can't complete tells the mortician so.
          recapResult(m, 'the ritual failed');
          if (m.alive) report(m, '⚰️ Your ritual failed — the body would not stir.');
        }
      }
    });

    // 13. Executioner grudges dying the wrong way.
    G.players.filter(x => x.role === 'executioner' && !x.achievedWin && !x.lostWin).forEach(ex => {
      if (ex.execTargetId && killed.some(k => k.id === ex.execTargetId)) {
        ex.lostWin = true;
        report(ex, '🪓 Your target is dead — but not by the town’s hand. Your grudge dies unsettled.');
      }
    });

    // 14. Dawn intelligence.
    alivePlayers().forEach(p => {
      if (blocked.has(p.id)) {
        report(p, '🚫 Someone prevented you from acting last night.');
        recapResult(p, 'prevented by the Fixer'); // the recap shouldn't claim it happened
      }
    });
    // A guard who took the hit knows it — even when the doctor saved them.
    guardSaves.forEach(({ guard, targetId }) => {
      report(guard, `🛡 You took the hit meant for ${nameOf(targetId)} — the doctor pulled you through.`);
      recapResult(guard, `took the hit for ${nameOf(targetId)}, saved by the doctor`);
    });
    alivePlayers().filter(p => p.role === 'detective').forEach(d => {
      const t = eff(d);
      if (t && t !== 'skip') {
        const target = getPlayer(t);
        if (target) {
          const reads = target.role === 'don' ? false : (framed.has(t) || teamOf(target) === 'mafia');
          if (d.isBot) {
            (d.intel = d.intel || []).push({ targetId: t, isMafia: reads });
            // Hard evidence overrides gossip in the detective's own book.
            d.susp = d.susp || {};
            d.susp[t] = reads ? 10 : -6;
          }
          report(d, `🔍 ${target.name} is ${reads ? 'MAFIA 🔪' : 'not mafia ✅'}`);
          recapResult(d, reads ? 'mafia' : 'not mafia');
        }
      }
    });
    alivePlayers().filter(p => p.role === 'consigliere').forEach(c => {
      const t = eff(c);
      if (t && t !== 'skip') {
        const target = getPlayer(t);
        if (target && target.role) {
          report(c, `🧠 ${target.name} is the ${ROLES[target.role].icon} ${ROLES[target.role].name}.`);
          recapResult(c, ROLES[target.role].name);
        }
      }
    });
    alivePlayers().filter(p => p.role === 'watcher').forEach(w => {
      const t = eff(w);
      if (t && t !== 'skip') {
        const callers = visits.filter(v => v.target === t && v.visitor !== w.id).map(v => nameOf(v.visitor));
        report(w, callers.length
          ? `🪟 Visitors at ${nameOf(t)}'s door: ${[...new Set(callers)].join(', ')}.`
          : `🪟 No one came to ${nameOf(t)}'s door.`);
        recapResult(w, callers.length ? [...new Set(callers)].join(', ') : 'no visitors');
      }
    });
    alivePlayers().filter(p => p.role === 'tracker').forEach(tr => {
      const t = eff(tr);
      if (t && t !== 'skip') {
        const went = visits.find(v => v.visitor === t);
        report(tr, went
          ? `👣 ${nameOf(t)} went to visit ${nameOf(went.target)}.`
          : `👣 ${nameOf(t)} stayed home all night.`);
        recapResult(tr, went ? `visited ${nameOf(went.target)}` : 'stayed home');
      }
    });
    alivePlayers().filter(p => p.role === 'coroner').forEach(co => {
      const t = eff(co);
      if (t && t !== 'skip') {
        const body = getPlayer(t);
        if (body && !body.alive && body.role) {
          report(co, `🔬 The body of ${body.name}: they were the ${ROLES[body.role].icon} ${ROLES[body.role].name}.`);
          recapResult(co, ROLES[body.role].name);
        }
      }
    });

    // 15. Mayor pledge.
    let mayorName = null;
    alivePlayers().filter(p => p.role === 'mayor' && !p.pledged).forEach(m => {
      if (eff(m) === 'pledge') {
        m.pledged = true;
        mayorName = m.name;
        addLog(`${m.name} went public: they are the Mayor! Their vote now counts double.`, true);
      }
    });

    // Public log lines.
    killed.forEach(k => {
      const how = k.cause === 'vigilante' ? 'was shot' : k.cause === 'poison' ? 'succumbed to poison' : k.cause === 'guard' ? 'took a bullet meant for someone else' : 'was killed';
      addLog(`${k.name} ${how} in the night.${!settings.revealOnDeath ? '' : k.role ? ` They were the ${ROLES[k.role].name}.` : ' Their body was unrecognisable.'}`, true);
    });
    if (woundedNames.length) addLog(`${woundedNames.join(' and ')} ${woundedNames.length > 1 ? 'were' : 'was'} wounded in the night, but survived!`, true);
    let savedName = null;
    if (saved) {
      if (G.dayNum === 1) savedName = nameOf(savedId);
      addLog(savedName ? `${savedName} was attacked, but the doctor saved them!` : 'The doctor saved someone from an attack in the night!', true);
    }
    if (curedName) addLog(`💊 The doctor saved ${curedName} from the poison!`, true);
    if (revivedName) addLog(`⚰️ A miracle at dawn — ${revivedName} has risen from the dead!`, true);
    if (!killed.length && !woundedNames.length && !saved && !revivedName && !curedName) {
      addLog(forced ? 'The night was ended early.' : 'The night passed quietly.');
    }

    // Bookkeeper tally (after everything settles).
    alivePlayers().filter(p => p.role === 'bookkeeper').forEach(b => {
      report(b, `📒 The ledger says: ${aliveMafia().length} of the mafia still breathing.`);
    });

    // Day 1 gives the table almost nothing to go on — a rumour seeds the talk.
    // It's real intel, fuzzed: 70% of the time it names someone who genuinely
    // left their house tonight (mafia, doctor, any visitor — the rumour can't
    // tell them apart), 30% a red herring who stayed home.
    let rumour = null;
    if (G.dayNum === 1 && alivePlayers().length) {
      const outIds = [...new Set(visits.map(x => x.visitor))]
        .filter(id => { const pl = getPlayer(id); return pl && pl.alive; });
      const homeIds = alivePlayers().filter(pl => !outIds.includes(pl.id)).map(pl => pl.id);
      const pool = (outIds.length && (Math.random() < 0.7 || !homeIds.length)) ? outIds
        : (homeIds.length ? homeIds : outIds);
      if (pool.length) {
        const t = getPlayer(rndOf(pool));
        rumour = rndOf([
          `Old Mrs. Whittle swears she saw ${t.name} out on the street long after midnight.`,
          `${t.name}'s door creaked twice in the night — once going out, once coming back.`,
          `The baker was up before dawn and spotted ${t.name} crossing the square.`,
          `Muddy boots on ${t.name}'s porch this morning. They weren't there yesterday.`,
          `${t.name}'s lamp went dark at dusk… then someone lit it again at three.`,
        ]);
        addLog(`🗣 Rumour: ${rumour}`);
        // The table hears it too — a soft nudge, scaled by each bot's credulity.
        alivePlayers().filter(b => b.isBot && b.id !== t.id).forEach(b => bumpFor(b, t.id, 1));
        heatUp(t, 1);
      }
    }

    G.announce = {
      kind: 'dawn',
      rumour,
      killed: killed.map(k => ({ name: k.name, role: k.role, cause: k.cause })),
      woundedNames,
      savedName,
      saved,
      revivedName,
      curedName,
      mayorName,
    };

    if (checkWin()) return;

    // Deaths make the town re-read the record with hindsight.
    killed.forEach(k => reassessOnDeath(getPlayer(k.id)));

    G.phase = 'day';
    G.votes = {};
    G.ghostSaves = {};
    G.voteClosing = false;
    G.lastChatAt = Date.now(); // bots hold their votes until the table goes quiet
    setPhaseTimer(settings.dayTimer, () => { if (G && G.phase === 'day') resolveVote(true); });
    addLog(`Day ${G.dayNum} begins. The town votes.`);
    broadcast();
    processCallouts();
  }

  /* ---------------- day / voting ---------------- */

  function voteWeight(p) { return p.pledged ? 2 : 1; }

  function ghostCanVote(p) {
    return settings.ghostVote && !p.alive && !p.spectator && !p.ghostVoteUsed && p.role;
  }

  /* Ghosts with an unspent last vote must decide each day: cast it or save it. */
  function pendingGhosts() {
    return G.players.filter(x => ghostCanVote(x) && !(x.id in G.votes) && !G.ghostSaves[x.id]);
  }

  function maybeCloseVoting() {
    if (G.phase !== 'day') return;
    if (alivePlayers().some(v => !(v.id in G.votes))) return;
    if (pendingGhosts().length) return;
    // Everyone's decided — hold the final tally on screen for a beat.
    G.voteClosing = true;
    clearTimeout(voteCloseTimer);
    voteCloseTimer = setTimeout(() => {
      if (G && G.phase === 'day') resolveVote();
    }, 2000);
  }

  function handleVote(p, targetId) {
    if (G.phase !== 'day') return;
    if (!p.alive) {
      // One vote from beyond the grave — cast it, save it, or take it back.
      if (!ghostCanVote(p)) return;
      if (targetId === 'save') {
        delete G.votes[p.id];
        G.ghostSaves[p.id] = true;
        maybeCloseVoting();
        broadcast();
        return;
      }
      if (targetId === 'retract') {
        delete G.votes[p.id];
        delete G.ghostSaves[p.id];
        G.voteClosing = false;
        clearTimeout(voteCloseTimer);
        broadcast();
        return;
      }
      if (!alivePlayers().some(t => t.id === targetId)) return;
      delete G.ghostSaves[p.id];
      G.votes[p.id] = targetId;
      maybeCloseVoting();
      broadcast();
      return; // ghosts never force an early resolution on their own
    }
    const valid = targetId === 'nobody' ||
      (alivePlayers().some(t => t.id === targetId) && targetId !== p.id);
    if (!valid) return;
    G.votes[p.id] = targetId;
    maybeCloseVoting();
    broadcast();
  }

  function forceEndVoting() { resolveVote(true); }

  function resolveVote(forced) {
    if (G.phase !== 'day') return;
    clearTimeout(voteCloseTimer);
    G.voteClosing = false;

    // Ghost votes are spent the day they're counted.
    const ghostVoters = Object.keys(G.votes).map(getPlayer).filter(v => v && !v.alive);

    const tally = { nobody: 0 };
    let castWeight = 0;
    Object.entries(G.votes).forEach(([voterId, t]) => {
      const w = voteWeight(getPlayer(voterId));
      castWeight += w;
      tally[t] = (tally[t] || 0) + w;
    });
    ghostVoters.forEach(v => { v.ghostVoteUsed = true; });
    (G.voteHistory = G.voteHistory || []).push({ day: G.dayNum, votes: Object.assign({}, G.votes) });
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter(t => tally[t] === max && max > 0);

    let eliminated = null;
    let noMajority = false;
    if (top.length === 1 && top[0] !== 'nobody') {
      if (max > castWeight / 2) {
        eliminated = getPlayer(top[0]);
        eliminated.alive = false;
        eliminated.causeOfDeath = 'vote';
        addLog(`The village ganged up on ${eliminated.name} (${max}/${castWeight} votes)${settings.revealOnDeath ? ` — they were the ${ROLES[eliminated.role].name}` : ''}.`, true);
      } else {
        noMajority = true;
        addLog('No majority was reached — no one was eliminated.');
      }
    } else if (top.length > 1) {
      addLog('The vote was tied — no one was eliminated.');
    } else {
      addLog('The town chose to eliminate no one.');
    }

    // The elimination reveals a role — the town re-reads the record.
    if (eliminated) reassessOnDeath(eliminated);

    // Executioners: settled or spoiled grudges.
    if (eliminated) {
      G.players.filter(x => x.role === 'executioner' && !x.achievedWin && !x.lostWin).forEach(ex => {
        if (ex.execTargetId === eliminated.id) {
          ex.achievedWin = true;
          send(ex.id, { t: 'report', line: '🪓 Your grudge is settled — your target was voted out. You win when this game ends.' });
        }
      });
    }

    G.announce = {
      kind: 'verdict',
      eliminatedName: eliminated ? eliminated.name : null,
      eliminatedRole: eliminated ? eliminated.role : null,
      eliminatedId: eliminated ? eliminated.id : null,
      tied: !eliminated && !noMajority && top.length > 1,
      noMajority,
      forced: !!forced,
    };

    G.phase = 'verdict';
    G.lastWords = null;
    G.lastWordsDone = !settings.lastWords; // last words disabled → nothing to wait for
    setPhaseTimer(0);
    broadcast();

    // How the verdict ends: no elimination → short pause; a bot → after its
    // line lands; a human → wait for their last words (say-nothing button or
    // a 60s safety net if they've gone quiet).
    if (!settings.lastWords) scheduleVerdictEnd(eliminated ? 6000 : 5000);
    else if (!eliminated) scheduleVerdictEnd(5000);
    else if (eliminated.isBot) scheduleVerdictEnd(15000);
    else scheduleVerdictEnd(60000);

    if (settings.lastWords && eliminated && eliminated.isBot && !eliminated.forged) {
      const LAST_WORDS = {
        detective: ['I was the DETECTIVE, you fools! My notes… check my notes…', 'You’ve doomed us all — I was so close!'],
        doctor: ['Who’s going to patch you up now?', 'I saved your lives, and THIS is the thanks I get?'],
        vigilante: ['I still had a bullet with someone’s name on it…', 'Should’ve shot first and voted later.'],
        bodyguard: ['Who’ll take the bullet for you now?'],
        mayor: ['You’ve just voted out city hall itself!'],
        jester: ['HA! You absolute fools — this is EXACTLY what I wanted! 🃏', 'Thank you, thank you! You played right into my hands! 🃏',
                 '*cackles wildly* WORTH IT!', 'My finest performance yet. Curtain! 🃏'],
        executioner: ['My grudge dies with me… how poetic.'],
        drifter: ['I was just passing through, man…'],
      };
      const MAFIA_WORDS = ['You got me. Well played, town. 🔪', 'Fine, it was me. But the family is still out there… or are they?',
                           'The family will remember this.', 'You win this round. The streets won’t forget.', 'Heh. Took you long enough.'];
      const TOWN_WORDS = ['I was innocent, you monsters… avenge me!', 'You’ll regret this when the mafia gets you all!',
                          'I told you it wasn’t me…', 'Wrong person, geniuses.', 'My conscience is clean — can you say the same?',
                          'Remember me when the mafia comes knocking.', 'No hard feelings. (Some hard feelings.)'];
      // With roles hidden on death, everyone protests their innocence — a
      // role-revealing line would spill what the setting keeps secret.
      const hideRole = !settings.revealOnDeath && eliminated.role !== 'jester';
      const pool = hideRole ? TOWN_WORDS
        : teamOf(eliminated) === 'mafia'
          ? MAFIA_WORDS
          : [...(LAST_WORDS[eliminated.role] || []), ...TOWN_WORDS];
      const line = rndOf(!hideRole && LAST_WORDS[eliminated.role] && Math.random() < 0.6 ? LAST_WORDS[eliminated.role] : pool);
      setTimeout(() => {
        if (G && G.phase === 'verdict' && !G.lastWords && G.announce.eliminatedId === eliminated.id) {
          G.lastWords = line;
          G.lastWordsDone = true;
          addLog(`${eliminated.name}'s last words: “${line}”`);
          scheduleVerdictEnd(6000);
          broadcast();
        }
      }, 1500 + Math.random() * 1500);
    }
  }

  function scheduleVerdictEnd(ms) {
    clearTimeout(verdictTimer);
    verdictTimer = setTimeout(endVerdict, ms);
  }

  function endVerdict() {
    if (!G || G.phase !== 'verdict') return;
    if (G.announce.eliminatedRole === 'jester') {
      G.phase = 'ended';
      G.winner = 'jester';
      setPhaseTimer(0);
      addLog(`${G.announce.eliminatedName} was the Jester — the Jester wins alone! 🃏`, true);
      broadcast();
      return;
    }
    if (checkWin()) return;
    startNight();
  }

  /* One final message from a just-eliminated player, shown during the verdict.
   * The Forger's mark destroys it. */
  function handleLastWords(p, text) {
    if (!settings.lastWords) return;
    if (G.phase !== 'verdict' || G.lastWords || G.lastWordsDone) return;
    if (!G.announce || G.announce.eliminatedId !== p.id) return;
    if (text === '__skip__') {
      G.lastWordsDone = true;
      addLog(`${p.name} went quietly.`);
      scheduleVerdictEnd(4000);
      broadcast();
      return;
    }
    text = String(text || '').trim().slice(0, 100);
    if (!text) return;
    G.lastWordsDone = true;
    if (p.forged) {
      G.lastWords = '🔥 …the paper burns before anyone can read it. The last words are destroyed.';
      addLog(`${p.name}'s last words were mysteriously destroyed.`);
    } else {
      G.lastWords = text;
      addLog(`${p.name}'s last words: “${text}”`);
    }
    scheduleVerdictEnd(6000);
    broadcast();
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
      extraWinners().forEach(w => addLog(`${w.name} also wins: ${w.why}`, true));
      broadcast();
      return true;
    }
    return false;
  }

  /* Neutral side-winners once the game has a main winner. */
  function extraWinners() {
    const out = [];
    G.players.forEach(p => {
      if (p.role === 'executioner' && p.achievedWin) {
        out.push({ name: p.name, role: p.role, why: `their grudge against ${nameOf(p.execTargetId)} was settled — the town voted them out 🪓` });
      }
      if (p.role === 'drifter' && p.alive) out.push({ name: p.name, role: p.role, why: 'they drifted through alive 🎒' });
    });
    return out;
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
    if (localConn && id === localConn._playerId) return;
    const c = conns[id];
    if (c) { try { c.send({ t: 'error', fatal: true, msg: 'You were removed from the lobby by the host.' }); c.close(); } catch (e) {} }
    delete conns[id];
    G.players = G.players.filter(p => p.id !== id);
    broadcast();
  }

  /* ---------------- bot players ---------------- */

  const BOT_NAMES = [
    'Rita', 'Max', 'Ivy', 'Gus', 'Sal', 'Fay', 'Ned', 'Lou', 'Peg', 'Vic',
    'Milo', 'Otto', 'Nora', 'Iris', 'Enzo', 'Beau', 'Cleo', 'Dora', 'Ezra', 'Finn',
    'Hugo', 'June', 'Kira', 'Leon', 'Mona', 'Nico', 'Remy', 'Rosa', 'Thea', 'Wade',
    'Basil', 'Clara', 'Dolly', 'Edwin', 'Flora', 'Grace', 'Hazel', 'Jonas', 'Lydia',
    'Mabel', 'Oscar', 'Pearl', 'Rufus', 'Sadie', 'Tessa',
  ];

  function addBot() {
    if (!G || G.phase !== 'lobby' || G.players.length >= 15) return;
    // Random pick from whatever names are still free (humans might hold some).
    const free = BOT_NAMES.filter(n =>
      !G.players.some(p => p.name.toLowerCase() === n.toLowerCase()));
    if (!free.length) return;
    const name = rndOf(free);
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
    if (bot) {
      // Bots get a proper animal face like everyone else — a small 🤖 tag in
      // the UI marks them, so who's talking stays readable.
      const used = new Set(G.players.map(p => p.avatar));
      const free = AVATARS.filter(a => !used.has(a));
      bot.avatar = free.length ? rndOf(free) : rndOf(AVATARS);
      bot.isBot = true;
      broadcast();
    }
  }

  /* One pending timer per bot, delay chosen for the current phase; the wait
   * restarts if the phase changes, so actions land in their intended window. */
  function scheduleBot(conn) {
    if (!G || conn._pending) return;
    const phase = G.phase;
    const p = getPlayer(conn._playerId);
    const isPowerNight = phase === 'night' && p && nightUIFor(p) !== null;
    const delay = isPowerNight ? 2000 + Math.random() * 3000 : 1000 + Math.random() * 2000;
    conn._pending = setTimeout(() => {
      conn._pending = null;
      if (!G) return;
      if (G.phase !== phase) { scheduleBot(conn); return; }
      botAct(conn);
    }, delay);
  }

  /* Who this bot intends to vote for today — used for both its table talk
   * and its actual vote, so what it says always matches what it does. */
  function botVoteTarget(p) {
    if (p.role === 'detective' && p.intel) {
      const m = p.intel.map(i => getPlayer(i.targetId)).filter(t => t && t.alive && teamOf(t) === 'mafia');
      if (m.length) return m[0].id;
    }
    if (p.role === 'executioner' && p.execTargetId && !p.lostWin && !p.achievedWin) {
      const t = getPlayer(p.execTargetId);
      if (t && t.alive) return t.id;
    }
    // Personality shapes the vote.
    const tallies = {};
    Object.values(G.votes || {}).forEach(t => { if (t !== 'nobody') tallies[t] = (tallies[t] || 0) + 1; });
    let crowdId = null, crowdN = 0;
    Object.entries(tallies).forEach(([id, n]) => { if (n > crowdN) { crowdN = n; crowdId = id; } });
    const crowd = crowdId ? getPlayer(crowdId) : null;
    const crowdOk = crowd && crowd.alive && crowd.id !== p.id &&
      !(teamOf(p) === 'mafia' && teamOf(crowd) === 'mafia');
    if (p.persona === 'sheep' && crowdOk && crowdN >= 2 && Math.random() < 0.75) return crowd.id;
    const pick = botSuspicionPick(p, 2);
    if (p.persona === 'accuser' && pick) return pick.id;          // always has a target
    if (p.persona === 'analyst') {
      const strong = botSuspicionPick(p, 3);
      if (strong) return strong.id;
      if (Math.random() < 0.6) return 'nobody';                   // won't vote on vibes
    }
    if (p.persona === 'contrarian' && crowdOk && pick && pick.id === crowdId && Math.random() < 0.6) {
      const alt = botSuspicionPick(p, 2);
      if (alt && alt.id !== crowdId) return alt.id;               // anyone but the obvious
    }
    if (pick && Math.random() < 0.75) return pick.id;
    if (teamOf(p) === 'mafia') {
      const town = alivePlayers().filter(t => teamOf(t) !== 'mafia');
      return (town.length && Math.random() < 0.8) ? rndOf(town).id : 'nobody';
    }
    const opts = alivePlayers().filter(t => t.id !== p.id).map(t => t.id);
    opts.push('nobody', 'nobody', 'nobody');
    return opts.length ? rndOf(opts) : 'nobody';
  }

  function botLine(p) {
    const r = Math.random();

    if (p.role === 'doctor' && G.announce && G.announce.kind === 'dawn' &&
        (G.announce.saved || G.announce.savedName) && r < 0.35) {
      return rndOf([
        'Lucky someone was watching over the town last night…',
        'Good thing nobody died, eh? 😉',
      ]);
    }
    if (p.role === 'jester' && r < 0.4) {
      return rndOf([
        'Honestly? It could easily be me. Who knows! 😏',
        'I’m not saying it’s me… but I’m not NOT saying it.',
        'Vote for whoever you want. Even me. ESPECIALLY me— I mean, no one.',
        '*whistles suspiciously*',
      ]);
    }

    // Decide the vote first; talk about THAT person (or stay non-committal).
    const targetId = botVoteTarget(p);
    p.chatIntent = { day: G.dayNum, target: targetId };
    const t = targetId && targetId !== 'nobody' ? getPlayer(targetId) : null;

    if (t) {
      if (p.role === 'detective' && p.intel && p.intel.some(i => i.targetId === t.id && i.isMafia)) {
        return rndOf([
          `I'm the detective — ${t.name} is mafia. Vote them out!`,
          `Listen carefully: it's ${t.name}. I'd bet my badge on it.`,
          `I've been watching ${t.name} all night… it's them.`,
        ]);
      }
      // A mafia killer may risk one FAKE detective claim per game to frame
      // someone — gambling that the real detective stays quiet.
      if ((p.role === 'mafia' || p.role === 'don') && !G.fakeClaimUsed && G.dayNum >= 2 && Math.random() < 0.15) {
        G.fakeClaimUsed = true;
        return rndOf([
          `I'm the detective — ${t.name} is mafia. Vote them out!`,
          `Detective here. My investigation says it's ${t.name}.`,
        ]);
      }
      if (p.role === 'executioner' && t.id === p.execTargetId) {
        return rndOf([
          `I've got a bad feeling about ${t.name}.`,
          `${t.name} has been lying since day one. Vote them out.`,
          `If we vote anyone today, it should be ${t.name}.`,
        ]);
      }
      return rndOf([
        `${t.name} is acting really suspicious, if you ask me.`,
        `My money's on ${t.name}.`,
        `I don't trust ${t.name} one bit.`,
        `Something about ${t.name} feels off today.`,
        `I say we vote out ${t.name} and be done with it.`,
        `${t.name}, care to explain yourself?`,
        `Did anyone else notice ${t.name} acting strange?`,
      ]);
    }

    // Intending to spare everyone — sound like it.
    if (p.role === 'detective' && p.intel) {
      const cleared = p.intel.map(i => !i.isMafia ? getPlayer(i.targetId) : null).filter(x => x && x.alive);
      if (cleared.length && r < 0.5) {
        const c = rndOf(cleared);
        return rndOf([
          `For what it's worth, I'm certain ${c.name} is innocent.`,
          `It's definitely not ${c.name} — let's look elsewhere.`,
        ]);
      }
    }
    // Personality colours the small talk.
    const PERSONA_LINES = {
      accuser: ['Somebody at this table is lying badly.', 'I’m not waiting all day — start pointing fingers.', 'Every quiet mouth is hiding something.'],
      analyst: ['Look at the votes, not the noise.', 'Patterns don’t lie. People do.', 'Who benefited from last night? Start there.'],
      sheep: ['I’ll go with the group on this one.', 'So… what’s everyone else thinking?', 'Whoever most of you pick works for me.'],
      contrarian: ['The obvious pick is exactly who it ISN’T.', 'You’re all sprinting the wrong way, as usual.', 'Popular opinion got the last one wrong too.'],
      showman: ['Place your bets, folks — who hangs at sundown? 🎪', 'Day drama! My favourite kind.', 'Someone confess, this lull is killing me.'],
    };
    if (p.persona && PERSONA_LINES[p.persona] && Math.random() < 0.45) {
      return rndOf(PERSONA_LINES[p.persona]);
    }
    return rndOf([
      'Let’s not vote anyone out yet, it’s too early.',
      'We should think carefully before voting.',
      'I was asleep all night, honest.',
      'The mafia is definitely among us… but I’m not sure who.',
      'I’m holding my vote until someone slips up.',
      'Quiet day. Too quiet.',
    ]);
  }

  /* A bot's night decision, driven by what it knows: table-talk suspicion,
   * detective claims it heard, who was attacked before, and its own history. */
  function botNightChoice(p, ui) {
    const PSEUDO = ['pledge', 'hide', 'clean'];
    const T = ui.targets.map(t => t.id).filter(id => !PSEUDO.includes(id));
    const inT = id => id && T.includes(id);
    const s = id => suspOf(p, id);
    const suspLeader = (min, list) => {
      let best = null;
      (list || T).forEach(id => { if (s(id) >= min && (!best || s(id) > s(best))) best = id; });
      return best;
    };
    // The family kills one villager a night; support roles shouldn't waste
    // their ability on someone who'll be dead by morning anyway.
    const killPicks = new Set(teamOf(p) === 'mafia'
      ? killers().map(m => G.night.actions[m.id]).filter(t => t && t !== 'skip') : []);
    const offKill = killPicks.size ? T.filter(id => !killPicks.has(id)) : T;
    const TK = offKill.length ? offKill : T;
    const mostTrusted = list => {
      let best = null;
      (list || T).forEach(id => { if (!best || s(id) < s(best)) best = id; });
      return best;
    };
    const claimant = [...(G.detClaimants || [])].map(getPlayer)
      .find(c => c && c.alive && inT(c.id));
    const role = p.role;

    if (role === 'mafia' || role === 'don') {
      if (claimant && Math.random() < 0.75) return claimant.id; // silence the "detective"
      const trusted = mostTrusted();
      if (trusted && Math.random() < 0.5) return trusted;       // credible townsfolk are dangerous
      return T.length ? rndOf(T) : 'skip';
    }
    if (role === 'detective') {
      const seen = new Set((p.intel || []).map(i => i.targetId));
      const fresh = T.filter(id => !seen.has(id));
      if (!fresh.length) return rndOf(T);
      // Anyone else claiming to be the detective is lying — check them first.
      const fake = [...(G.detClaimants || [])].map(getPlayer)
        .find(c => c && c.alive && c.id !== p.id && !seen.has(c.id) && inT(c.id));
      if (fake) return fake.id;
      let best = null;
      fresh.forEach(id => { if (!best || s(id) > s(best)) best = id; });
      // Chase the accusations most nights; sometimes canvas the quiet ones.
      return (s(best) >= 2 && Math.random() < 0.7) ? best : rndOf(fresh);
    }
    if (role === 'doctor' || role === 'bodyguard') {
      // A poisoned doctor knows it — physician, heal thyself.
      if (role === 'doctor' && p.poisonedNight !== null && inT(p.id)) return p.id;
      const pri = (G.protectPriority || []).find(id => inT(id));
      if (pri && Math.random() < 0.7) return pri;              // they'll come back for them
      if (claimant && Math.random() < 0.5) return claimant.id; // shield the claimed detective
      if (role === 'doctor' && inT(p.id) && Math.random() < 0.3) return p.id;
      return rndOf(T);
    }
    if (role === 'vigilante') {
      // Suspicion halves at nightfall, so scores here are already discounted:
      // 4+ means near-certainty (detective intel, an exposed liar), 2+ means
      // someone was loudly accused today.
      const sure = suspLeader(4);
      if (sure) return sure;
      const day = G.dayNum, aliveN = alivePlayers().length;
      const sus = suspLeader(2);
      if (sus && Math.random() < Math.min(0.9, 0.45 + 0.15 * day)) return sus;
      // Endgame, or still sitting on ammo late: a hunch beats a wasted bullet.
      if (aliveN <= 5 || day >= 4) {
        const hunch = suspLeader(1);
        if (hunch && Math.random() < 0.75) return hunch;
      }
      return 'skip';
    }
    if (role === 'watcher' || role === 'tracker') {
      // Watch the suspects most nights, but sweep the quiet ones too.
      const sus = suspLeader(2);
      return (sus && Math.random() < 0.6) ? sus : rndOf(T);
    }
    if (role === 'coroner' || role === 'consigliere') {
      const seen = new Set((p.actions || []).filter(a => a.role === role && a.target).map(a => a.target));
      let fresh = ui.targets.filter(t => !PSEUDO.includes(t.id) && !seen.has(t.name)).map(t => t.id);
      if (role === 'consigliere') { const f2 = fresh.filter(id => !killPicks.has(id)); if (f2.length) fresh = f2; }
      return fresh.length ? rndOf(fresh) : (ui.canSkip ? 'skip' : rndOf(T));
    }
    if (role === 'mortician') {
      const power = ui.targets.filter(t => {
        const b = getPlayer(t.id);
        return b && ['doctor', 'detective', 'bodyguard', 'vigilante'].includes(b.role) && !b.cleaned;
      });
      if (power.length && Math.random() < 0.6) return rndOf(power).id; // raise the town's muscle
      return Math.random() < 0.15 && T.length ? rndOf(T) : 'skip';
    }
    if (role === 'mayor') {
      if ((p.heat || 0) >= 3 && Math.random() < 0.7) return 'pledge'; // clear their own name
      if (alivePlayers().length <= 5 && Math.random() < 0.35) return 'pledge';
      return 'skip';
    }
    if (role === 'fixer') {
      // No point jamming someone the family is killing tonight anyway.
      if (claimant && !killPicks.has(claimant.id) && Math.random() < 0.7) return claimant.id;
      return Math.random() < 0.8 && TK.length ? rndOf(TK) : 'skip';
    }
    if (role === 'framer') {
      return suspLeader(2, TK) || (TK.length ? rndOf(TK) : 'skip'); // pile evidence where eyes already are
    }
    if (role === 'poisoner') {
      const fresh = TK.filter(id => { const t = getPlayer(id); return t && t.poisonedNight === null; });
      if (claimant && fresh.includes(claimant.id)) return claimant.id;
      return fresh.length ? rndOf(fresh) : 'skip';
    }
    if (role === 'forger') {
      if (claimant && !killPicks.has(claimant.id) && Math.random() < 0.6) return claimant.id;
      return Math.random() < 0.3 && TK.length ? (mostTrusted(TK) || rndOf(TK)) : 'skip';
    }
    if (role === 'cleaner') {
      const picks = killers().map(m => G.night.actions[m.id])
        .filter(t => t && t !== 'skip').map(getPlayer).filter(Boolean);
      const power = picks.some(t => t.role && t.role !== 'villager');
      return (power ? Math.random() < 0.6 : Math.random() < 0.2) ? 'clean' : 'skip';
    }
    if (role === 'recruiter') {
      const mafiaN = aliveMafia().length;
      const townN = alivePlayers().length - mafiaN;
      if (townN - mafiaN >= 3 && Math.random() < 0.5) return mostTrusted() || rndOf(T); // turn a trusted villager
      return 'skip';
    }
    if (role === 'drifter') {
      if ((p.heat || 0) >= 3 && Math.random() < 0.7) return 'hide'; // heat's on — disappear
      return Math.random() < 0.12 ? 'hide' : 'skip';
    }
    return ui.canSkip ? 'skip' : (T.length ? rndOf(T) : null);
  }

  function botAct(conn) {
    if (!G) return;
    const p = getPlayer(conn._playerId);
    if (!p) return;
    // Dead bots decide their ghost vote: cast it on a strong lead, else save it.
    if (!p.alive) {
      if (G.phase === 'day' && ghostCanVote(p) && !(p.id in G.votes) && !G.ghostSaves[p.id]) {
        if (Date.now() - (G.lastChatAt || 0) < 6000) { scheduleBot(conn); return; }
        const known = p.intel && p.intel.map(i => getPlayer(i.targetId)).filter(t => t && t.alive && teamOf(t) === 'mafia');
        const pick = (known && known.length) ? known[0] : botSuspicionPick(p, 3);
        if (pick && Math.random() < 0.7) handleVote(p, pick.id);
        else handleVote(p, 'save');
      }
      return;
    }
    if (G.phase === 'reveal' && !G.confirms[p.id]) {
      handleConfirm(p);
    } else if (G.phase === 'night' && !(p.id in G.night.actions)) {
      const ui = nightUIFor(p);
      if (!ui) return;
      const choice = botNightChoice(p, ui);
      if (choice) {
        // Mafia bots call their shot on the family channel.
        if ((p.role === 'mafia' || p.role === 'don') && choice !== 'skip' && Math.random() < 0.5) {
          const t = getPlayer(choice);
          if (t) handleChat(p, rndOf([
            `Tonight it's ${t.name}. Agreed?`,
            `I say we pay ${t.name} a visit.`,
            `${t.name} has been too sharp. They sleep tonight.`,
          ]), 'mafia');
        }
        handleNightAction(p, choice);
      }
    } else if (G.phase === 'day') {
      if (conn._chatDay !== G.dayNum) {
        conn._chatDay = G.dayNum;
        // A poisoned bot begs for the doctor — its only chance of surviving.
        if (p.poisonedNight !== null && teamOf(p) !== 'mafia' && Math.random() < 0.85) {
          handleChat(p, rndOf([
            'I’ve been POISONED. Doctor — I need you tonight or I’m dead.',
            'Someone slipped me poison in the night. Doc, please… I don’t have long.',
            'I’m poisoned! Whoever the doctor is, tonight it has to be me.',
          ]));
        }
        handleChat(p, botLine(p));
        // …and mutter strategy where only the family can hear.
        if (p.role && teamOf(p) === 'mafia' && Math.random() < 0.4) {
          const ci = p.chatIntent;
          const t = ci && ci.target && ci.target !== 'nobody' ? getPlayer(ci.target) : null;
          handleChat(p, t && t.alive
            ? rndOf([`I'll keep the table pointed at ${t.name}.`, `Pile on ${t.name} if it comes to a vote.`, `${t.name} takes the fall today.`])
            : rndOf(['Heads down today — vote with the crowd.', 'Don’t defend me too hard, it looks worse.', 'Let the villagers eat each other.']), 'mafia');
        }
        return;
      }
      if (!(p.id in G.votes)) {
        // Votes wait until the table has been quiet for a while, so they're
        // cast on everything that was said — not on first impressions.
        if (Date.now() - (G.lastChatAt || 0) < 6000) { scheduleBot(conn); return; }
        // Start from what the bot declared at the table; decide fresh if it
        // never spoke today or its declared target has since died.
        let target = null;
        const ci = p.chatIntent;
        if (ci && ci.day === G.dayNum) {
          if (ci.target === 'nobody') target = 'nobody';
          else {
            const t = getPlayer(ci.target);
            if (t && t.alive && t.id !== p.id) target = t.id;
          }
        }
        if (!target) target = botVoteTarget(p) || 'nobody';
        // The discussion may have moved things on since the bot spoke: if a
        // clearly stronger suspect emerged, switch — and say so, to keep the
        // vote and the table talk in step.
        const fresh = botSuspicionPick(p, 2);
        if (fresh && fresh.id !== target &&
            suspOf(p, fresh.id) >= (target === 'nobody' ? 3 : suspOf(p, target) + 3)) {
          p.chatIntent = { day: G.dayNum, target: fresh.id };
          handleChat(p, rndOf([
            `Hearing all that… my vote's going to ${fresh.name}.`,
            `Actually — it's ${fresh.name}. I'm sure now.`,
            `Fine, you've convinced me. ${fresh.name}.`,
          ]));
          target = fresh.id;
        }
        handleVote(p, target);
      }
    }
  }

  /* ---------------- per-player state views ---------------- */

  function broadcast() {
    G.players.forEach(p => send(p.id, { t: 'state', view: viewFor(p) }));
    render();
    saveSnapshot();
    // Keep the public listing's names/counts fresh as the lobby changes:
    // announce at most every 5s, but never drop the latest state — a change
    // inside the throttle window schedules a trailing announcement.
    if (G.phase === 'lobby' && settings.publicGame) {
      const wait = 5000 - (Date.now() - lastAnnounce);
      if (wait <= 0) announcePublic();
      else {
        clearTimeout(pendingAnnounce);
        pendingAnnounce = setTimeout(() => {
          if (G && G.phase === 'lobby' && settings.publicGame) announcePublic();
        }, wait + 100);
      }
    }
  }

  /* Who voted for whom on past days (before `beforeDay`; pass Infinity for all). */
  function voteHistoryFor(beforeDay) {
    return (G.voteHistory || [])
      .filter(h => h.day < beforeDay)
      .map(h => ({
        day: h.day,
        rows: Object.entries(h.votes).map(([voter, target]) => ({
          voter: nameOf(voter),
          target: target === 'nobody' ? 'no one' : nameOf(target),
        })),
      }));
  }

  /* The chat stream as one player sees it: everyone gets the main channel and
   * dividers; only the dead also see the ghosts' whispers. */
  function chatFor(p) {
    return G.chat.filter(m => m.divider || !m.chan || (m.chan === 'ghost' && !p.alive)).slice(-150);
  }

  /* The public announcement, with roles stripped when they stay secret on death. */
  function maskedAnnounce() {
    const a = G.announce;
    if (!a || settings.revealOnDeath || G.phase === 'ended') return a;
    if (a.kind === 'dawn') {
      return Object.assign({}, a, { killed: (a.killed || []).map(k => Object.assign({}, k, { role: null })) });
    }
    if (a.kind === 'verdict') return Object.assign({}, a, { eliminatedRole: null });
    return a;
  }

  function roleVisibleTo(viewer, target) {
    if (G.phase === 'ended') return true;
    if (viewer && viewer.id === target.id) return true;
    if (target.cleaned) return false; // the Cleaner scrubbed this body
    if (!target.alive && settings.revealOnDeath) return true;
    if (target.pledged) return true;  // the Mayor went public
    if (viewer && teamOf(viewer) === 'mafia' && teamOf(target) === 'mafia' && G.phase !== 'lobby') return true;
    return false;
  }

  /* Extra facts a player sees on their own role card. */
  function roleInfoFor(p) {
    const info = [];
    if (p.recruited) info.push('🤝 You have been recruited — you now win with the mafia.');
    if (p.alive && p.poisonedNight !== null) info.push('☠️ You are POISONED — unless the doctor heals you tonight, you die at dawn.');
    if (p.role === 'vigilante') {
      if (p.guilt) info.push('Your guilt has holstered your gun for good.');
      else if (p.bullets <= 0) info.push('No bullets left.');
      else info.push(`Bullets left: ${p.bullets} (usable from Night 2).${G.dayNum >= 3 && p.bullets >= 2 ? ' They’re no use to a dead man — trust your gut.' : ''}`);
    }
    if (p.role === 'executioner' && p.execTargetId) {
      info.push(`Your target: ${nameOf(p.execTargetId)}${p.achievedWin ? ' — grudge settled, you win! 🪓' : p.lostWin ? ' — died the wrong way. You lose.' : ''}`);
    }
    if (p.role === 'mayor' && p.pledged) info.push('You are public — your vote counts double.');
    if (p.role === 'forger') info.push(`Forgeries left: ${p.forgerUses}.`);
    if (p.role === 'cleaner') info.push(`Cleans left: ${p.cleanerUses}.`);
    if (p.role === 'drifter') info.push(`Lie-low nights left: ${p.drifterUses}.`);
    if (p.role === 'mortician') info.push(p.usedRaise ? 'Your power is spent.' : 'One revival available.');
    if (p.role === 'recruiter') info.push(p.recruiterUsed ? 'Your offer has been made.' : 'One offer available, from Night 2.');
    return info;
  }

  function viewFor(p) {
    const view = {
      roomCode,
      phase: G.phase,
      dayNum: G.dayNum,
      minPlayers: MIN_PLAYERS,
      winner: G.winner,
      announce: maskedAnnounce(),
      roleSummary: G.players.length >= MIN_PLAYERS ? roleSummary(G.players.length, deckOpts()) : null,
      settings: {
        safeFirstNight: settings.safeFirstNight, maxMafia: settings.maxMafia, showVoters: settings.showVoters,
        noSelfHeal: settings.noSelfHeal, nightTimer: settings.nightTimer, dayTimer: settings.dayTimer,
        lastWords: settings.lastWords, revealOnDeath: settings.revealOnDeath,
        extraRoles: Object.keys(settings.roles).filter(r => settings.roles[r]),
      },
      timer: G.deadline ? { deadline: G.deadline, hostNow: Date.now() } : null,
      you: {
        id: p.id, name: p.name, alive: p.alive, avatar: p.avatar, spectator: !!p.spectator,
        role: G.phase === 'lobby' ? null : p.role,
        info: G.phase === 'lobby' ? [] : roleInfoFor(p),
      },
      players: G.players.map(t => ({
        id: t.id, name: t.name, alive: t.alive, connected: t.connected, avatar: t.avatar,
        spectator: !!t.spectator,
        pledged: !!t.pledged,
        isBot: !!t.isBot,
        role: roleVisibleTo(p, t) && G.phase !== 'lobby' && t.role ? t.role : null,
        poisoned: !!(p.role && teamOf(p) === 'mafia' && t.alive && t.poisonedNight !== null),
        causeOfDeath: t.alive ? null : t.causeOfDeath,
      })),
    };

    if (G.phase === 'reveal') {
      view.reveal = {
        confirmed: !!G.confirms[p.id],
        waitingOn: G.players.filter(pl => !pl.spectator && !G.confirms[pl.id]).length,
        canPickRole: soloHuman(p),
        pickableRoles: soloHuman(p) ? [...new Set(G.players.map(x => x.role))] : null,
      };
    }

    if (G.phase === 'night' && p.alive) {
      const ui = nightUIFor(p);
      const actionVal = G.night.actions[p.id];
      view.night = {
        acted: p.id in G.night.actions,
        actionTarget: actionVal && actionVal !== 'skip' && !['pledge', 'hide', 'clean'].includes(actionVal) ? nameOf(actionVal) : null,
        actionSpecial: ['pledge', 'hide', 'clean'].includes(actionVal) ? actionVal : null,
        heldFire: actionVal === 'skip',
        prompt: ui ? ui.prompt : null,
        targets: ui ? ui.targets : [],
        canSkip: !!(ui && ui.canSkip),
        skipLabel: ui && ui.skipLabel ? ui.skipLabel : '🕊 Skip',
        mates: teamOf(p) === 'mafia'
          ? aliveMafia().filter(m => m.id !== p.id).map(m => ({
              name: m.name, avatar: m.avatar, isBot: !!m.isBot, role: ROLES[m.role].name,
              pick: G.night.actions[m.id] && G.night.actions[m.id] !== 'skip' && !['pledge', 'hide', 'clean'].includes(G.night.actions[m.id])
                ? nameOf(G.night.actions[m.id]) : null,
            }))
          : null,
        waitingOn: nightActors().filter(a => !(a.id in G.night.actions)).length,
        // After a 10s grace, name who we're waiting for (host option).
        waitingNames: settings.showNightWaiting && Date.now() - (G.nightStartedAt || 0) > 10000
          ? nightActors().filter(a => !(a.id in G.night.actions)).map(a => `${a.avatar || ''} ${a.name}`)
          : null,
      };
    }

    if (G.phase === 'lobby') {
      view.chat = chatFor(p);
      view.canChat = true;
    }

    // The mafia's private channel runs day and night.
    if ((G.phase === 'day' || G.phase === 'night') && p.alive && p.role && teamOf(p) === 'mafia') {
      view.mafiaChat = G.chat.filter(m => m.chan === 'mafia').slice(-60);
    }

    if (G.phase === 'day') {
      const counts = {};
      const voters = {};
      Object.entries(G.votes).forEach(([voterId, t]) => {
        const v = getPlayer(voterId);
        counts[t] = (counts[t] || 0) + voteWeight(v);
        (voters[t] = voters[t] || []).push((v.alive ? '' : '👻 ') + v.name);
      });
      const aliveWeight = alivePlayers().reduce((s, x) => s + voteWeight(x), 0);
      view.vote = {
        yourVote: G.votes[p.id] || null,
        counts,
        voters: settings.showVoters ? voters : null,
        voted: alivePlayers().filter(x => x.id in G.votes).length,
        needed: alivePlayers().length,
        majority: Math.floor(aliveWeight / 2) + 1,
        closing: !!G.voteClosing,
        ghost: ghostCanVote(p),
        ghostSaved: !!G.ghostSaves[p.id],
        ghostsPending: pendingGhosts().length,
        ghostSpent: !p.alive && !p.spectator && !!p.ghostVoteUsed && settings.ghostVote,
        // The whole roster: the fallen stay in the list (not votable) so the
        // day screen shows who's already gone.
        targets: G.players.filter(t => !t.spectator).map(t => ({
          id: t.id, name: t.name, avatar: t.avatar, self: t.id === p.id,
          isBot: !!t.isBot, pledged: !!t.pledged,
          dead: !t.alive, causeOfDeath: t.alive ? null : t.causeOfDeath,
          // Roles show wherever the viewer may see them (own team for the
          // mafia, the public mayor, the dead when reveals are on).
          role: roleVisibleTo(p, t) && t.role ? t.role : null,
          poisoned: !!(p.role && teamOf(p) === 'mafia' && t.alive && t.poisonedNight !== null),
        })),
      };
      view.chat = chatFor(p);
      view.canChat = true;           // the dead whisper on the ghost channel
      view.ghostChat = !p.alive;
      // "Previously…" — the story so far, at a glance.
      view.daySummary = {
        alive: alivePlayers().length,
        total: G.players.filter(x => !x.spectator).length,
        dead: G.players.filter(x => !x.alive && !x.spectator).map(x => ({
          name: x.name, avatar: x.avatar, cause: x.causeOfDeath,
          role: roleVisibleTo(p, x) && x.role ? x.role : null,
        })),
      };
      view.voteHistory = voteHistoryFor(G.dayNum);
    }

    // Solo test vs bots: expose each bot's personal suspicion table.
    if (soloHuman(p) && ['night', 'day', 'verdict'].includes(G.phase)) {
      view.suspicionDebug = G.players
        .filter(b => b.isBot && b.alive)
        .map(b => ({
          name: b.name, avatar: b.avatar, heat: b.heat || 0,
          persona: b.persona || null,
          credulity: Math.round((b.credulity || 1) * 100) / 100,
          sees: alivePlayers()
            .filter(t => t.id !== b.id)
            .map(t => ({ name: t.name, avatar: t.avatar, score: suspOf(b, t.id) }))
            .filter(x => x.score !== 0)
            .sort((a, c) => c.score - a.score),
        }));
    }

    if (G.phase === 'verdict') {
      view.verdict = {
        lastWords: G.lastWords,
        canSay: !!(G.announce && G.announce.eliminatedId === p.id && !G.lastWords && !G.lastWordsDone),
        waiting: !!(G.announce && G.announce.eliminatedId && !G.lastWords && !G.lastWordsDone),
        waitingName: G.announce ? G.announce.eliminatedName : null,
      };
    }

    if (G.phase === 'ended') {
      const extras = extraWinners();
      const team = teamOf(p);
      view.recap = {
        timeline: G.log.filter(e => e.important).map(e => e.text),
        yours: (p.actions || []).slice(),
        all: G.players.filter(x => !x.spectator && x.role).map(x => ({
          name: x.name, avatar: x.avatar, role: x.role, you: x.id === p.id,
          actions: (x.actions || []).slice(),
        })),
        gameId: G.gameId || null,
        youWon: !p.spectator && !!p.role && (
          extras.some(w => w.name === p.name) ||
          (G.winner === 'mafia' && team === 'mafia') ||
          (G.winner === 'town' && team === 'town') ||
          (G.winner === 'jester' && p.role === 'jester')),
      };
      view.voteHistory = voteHistoryFor(Infinity);
      view.extraWinners = extras;
    }

    return view;
  }

  /* ---------------- host controls UI ---------------- */

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

  // Roles that only work with a certain game option in a certain position.
  // Ticking the role forces the option there; moving the option away unticks
  // the role. Coroner/Bookkeeper trade in role intel, so deaths must NOT
  // reveal roles publicly or their powers are worthless.
  const ROLE_NEEDS = {
    forger: { setting: 'lastWords', value: true, label: 'needs “last words” on' },
    coroner: { setting: 'revealOnDeath', value: false, label: 'needs “reveal roles on death” OFF' },
    bookkeeper: { setting: 'revealOnDeath', value: false, label: 'needs “reveal roles on death” OFF' },
  };

  const ROLE_GROUPS = [
    { title: '🏘 Village', roles: ['bodyguard', 'vigilante', 'watcher', 'tracker', 'coroner', 'bookkeeper', 'mayor', 'mortician'] },
    { title: '🔪 Mafia', roles: ['don', 'fixer', 'framer', 'poisoner', 'consigliere', 'forger', 'cleaner', 'recruiter'] },
    { title: '🎭 Neutral', roles: ['jester', 'executioner', 'drifter'] },
  ];

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
          <label class="opt" style="justify-content:center;margin-top:10px"><input type="checkbox" id="opt-public" ${settings.publicGame ? 'checked' : ''}>
            🌐 Public game — anyone can find this room on the join page</label>
        </div>
        <div class="card">
          <div class="section-title"><h3>Host controls</h3>
            <span class="muted small-text">${n >= MIN_PLAYERS ? esc(roleSummary(n, deckOpts())) : `need ${MIN_PLAYERS - n} more`}</span></div>
          <div class="player-list">${G.players.map(p => `
            <div class="player-row">
              <span class="dot ${p.connected ? 'on' : 'off'}"></span>
              <span class="name">${p.avatar || ''} ${esc(p.name)}${p.isBot ? ' <span class="bot-tag">🤖</span>' : ''}${localConn && p.id === localConn._playerId ? ' (you)' : ''}</span>
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
          <label class="opt"><input type="checkbox" id="opt-ghost-vote" ${settings.ghostVote ? 'checked' : ''}>
            👻 The dead get one last vote — usable on any later day</label>
          <label class="opt"><input type="checkbox" id="opt-night-waiting" ${settings.showNightWaiting ? 'checked' : ''}>
            😴 After 10 seconds, show who the night is still waiting on <span class="muted small-text">(hints at who holds a night role)</span></label>
          <label class="opt"><input type="checkbox" id="opt-last-words" ${settings.lastWords ? 'checked' : ''}>
            🪦 Eliminated players leave last words <span class="muted small-text">(the Forger needs this on)</span></label>
          <label class="opt"><input type="checkbox" id="opt-reveal-death" ${settings.revealOnDeath ? 'checked' : ''}>
            Reveal a player's role when they die <span class="muted small-text">(the Coroner and Bookkeeper need this OFF — their intel is the substitute)</span></label>
          <label class="opt">Night timer:
            <select id="opt-night-timer">${[[0, 'No limit'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']].map(([v, l]) =>
              `<option value="${v}" ${settings.nightTimer === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label class="opt">Discussion timer:
            <select id="opt-day-timer">${[[0, 'No limit'], [120, '2 min'], [180, '3 min'], [300, '5 min'], [600, '10 min']].map(([v, l]) =>
              `<option value="${v}" ${settings.dayTimer === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
        </div>
        <div class="card"><h3>Extra roles</h3>
          <p class="hint" style="margin:4px 0 8px">Enabled roles join the deck when there are enough players (Villager seats are used first).
          ⚠️ Every mafia support role grows the mafia team — enable a similar number of village roles to keep the game fair.</p>
          ${ROLE_GROUPS.map(g => `<p class="small-text muted" style="margin:10px 0 2px">${g.title}</p>` +
            g.roles.map(r => `
              <label class="opt opt-role"><input type="checkbox" data-role-opt="${r}" ${settings.roles[r] ? 'checked' : ''}>
                <span><strong>${ROLES[r].icon} ${ROLES[r].name}</strong>${ROLE_NEEDS[r] ? ` <span class="muted small-text">⚙️ ${ROLE_NEEDS[r].label}</span>` : ''}<br>
                <span class="muted small-text">${esc(ROLES[r].desc)}</span></span></label>`).join('')
          ).join('')}
        </div>`;
    }

    if (G.phase === 'reveal') {
      const pending = G.players.filter(p => !p.spectator && !G.confirms[p.id]).length;
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
          <p class="muted small-text" style="margin:6px 0 10px">Votes cast: ${alivePlayers().filter(x => x.id in G.votes).length}/${alivePlayers().length}${pendingGhosts().length ? ` · ${pendingGhosts().length} ghost vote${pendingGhosts().length > 1 ? 's' : ''} undecided` : ''}. A strict majority is needed to eliminate.</p>
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

    // During the game, the host's extra panels fold away so their screen
    // looks like everyone else's; the lobby keeps them open (they ARE the UI).
    if (G.phase === 'lobby') {
      html += logHTML();
    } else {
      const openNow = G.phase === 'ended' ? true : hostPanelOpen;
      html = `<details class="host-fold" id="host-fold" ${openNow ? 'open' : ''}>
        <summary>🛠 Host controls &amp; public log</summary>${html}${logHTML()}</details>`;
    }
    c.innerHTML = html;

    const fold = el('host-fold');
    if (fold) fold.ontoggle = () => { hostPanelOpen = fold.open; };

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
    const op = el('opt-public');
    if (op) op.onchange = () => {
      if (op.checked) { settings.publicGame = true; announcePublic(); }
      else { announcePublic(true); settings.publicGame = false; }
      broadcast();
    };
    const os = el('opt-safe-night');
    if (os) os.onchange = () => { settings.safeFirstNight = os.checked; broadcast(); };
    const om = el('opt-max-mafia');
    if (om) om.onchange = () => { settings.maxMafia = parseInt(om.value, 10) || 0; broadcast(); };
    const ov = el('opt-show-voters');
    if (ov) ov.onchange = () => { settings.showVoters = ov.checked; broadcast(); };
    const osh = el('opt-no-self-heal');
    if (osh) osh.onchange = () => { settings.noSelfHeal = osh.checked; broadcast(); };
    const ogv = el('opt-ghost-vote');
    if (ogv) ogv.onchange = () => { settings.ghostVote = ogv.checked; broadcast(); };
    const onw = el('opt-night-waiting');
    if (onw) onw.onchange = () => { settings.showNightWaiting = onw.checked; broadcast(); };
    const olw = el('opt-last-words');
    if (olw) olw.onchange = () => {
      settings.lastWords = olw.checked;
      if (!olw.checked) settings.roles.forger = false; // the Forger has nothing to burn
      broadcast();
    };
    const ord = el('opt-reveal-death');
    if (ord) ord.onchange = () => {
      settings.revealOnDeath = ord.checked;
      // With roles announced on every death, the intel roles have no job.
      if (ord.checked) { settings.roles.coroner = false; settings.roles.bookkeeper = false; }
      broadcast();
    };
    const ont = el('opt-night-timer');
    if (ont) ont.onchange = () => { settings.nightTimer = parseInt(ont.value, 10) || 0; broadcast(); };
    const odt = el('opt-day-timer');
    if (odt) odt.onchange = () => { settings.dayTimer = parseInt(odt.value, 10) || 0; broadcast(); };
    c.querySelectorAll('[data-role-opt]').forEach(cb => {
      cb.onchange = () => {
        const r = cb.dataset.roleOpt;
        settings.roles[r] = cb.checked;
        // A role that depends on a game option drags that option into place.
        if (cb.checked && ROLE_NEEDS[r]) settings[ROLE_NEEDS[r].setting] = ROLE_NEEDS[r].value;
        broadcast();
      };
    });
  }

  return { create, destroy, resume, snapshotInfo, PEER_PREFIX };
})();
