/* Role definitions and role assignment logic. Shared by host and player UIs. */

const ROLES = {
  mafia: {
    id: 'mafia',
    name: 'Mafia',
    team: 'mafia',
    icon: '🔪',
    desc: 'You are part of the mafia. Each night, choose someone to eliminate. You know who your fellow mafia are. Win when the mafia equal or outnumber everyone else.',
    nightPrompt: 'Choose someone to eliminate tonight',
  },
  doctor: {
    id: 'doctor',
    name: 'Doctor',
    team: 'town',
    icon: '💉',
    desc: 'Each night, choose one person to protect. If the mafia target them, they survive. You may protect yourself.',
    nightPrompt: 'Choose someone to protect tonight',
  },
  detective: {
    id: 'detective',
    name: 'Detective',
    team: 'town',
    icon: '🔍',
    desc: 'Each night, investigate one person and learn whether they are mafia. Use your findings to guide the town — carefully.',
    nightPrompt: 'Choose someone to investigate tonight',
  },
  vigilante: {
    id: 'vigilante',
    name: 'Vigilante',
    team: 'town',
    icon: '🔫',
    desc: 'You have one bullet for the whole game. Any night, you may shoot someone you suspect — or hold your fire. Choose wisely: killing a townsperson helps the mafia.',
    nightPrompt: 'Shoot someone — or hold your fire',
  },
  jester: {
    id: 'jester',
    name: 'Jester',
    team: 'jester',
    icon: '🃏',
    desc: 'You win alone if the village votes you out. Act suspicious — but not too suspicious. You don’t care who else wins; being eliminated by vote is your victory.',
    nightPrompt: null,
  },
  villager: {
    id: 'villager',
    name: 'Villager',
    team: 'town',
    icon: '🧑‍🌾',
    desc: 'You have no special powers — just your wits. Pay attention during the day and vote out the mafia before they get you.',
    nightPrompt: null,
  },
};

const MIN_PLAYERS = 4;

/* Shared PeerJS options. STUN alone fails on restrictive networks (guest
 * Wi-Fi with client isolation, blocked UDP, cellular CGNAT), so a TURN
 * relay (Metered) provides the fallback path — the turns:443 TCP endpoint
 * gets through networks that only allow HTTPS-style traffic. */
const TURN_USER = 'a44214e32acbc0ccccebf87d';
const TURN_PASS = 'qT0S5RzWuh9VSFYe';
const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: TURN_USER, credential: TURN_PASS },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: TURN_USER, credential: TURN_PASS },
      { urls: 'turn:global.relay.metered.ca:443', username: TURN_USER, credential: TURN_PASS },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS },
    ],
  },
};

/* Avatars players can pick in the lobby. */
const AVATARS = ['🦊', '🐻', '🐼', '🐸', '🐯', '🦁', '🐮', '🐷',
                 '🐨', '🐰', '🦉', '🦄', '🐙', '🦈', '🐺', '🐝',
                 '🦋', '🐢', '🐳', '🦅', '🐴', '🐲', '👻', '🎃'];

/* Number of mafia for a given player count; maxMafia (0 = auto) caps it. */
function mafiaCount(n, maxMafia) {
  const auto = Math.max(1, Math.round(n / 4));
  return maxMafia ? Math.min(auto, maxMafia) : auto;
}

/* Which roles a game of n players gets, given the host's options. */
function deckComposition(n, opts) {
  opts = opts || {};
  const nMafia = mafiaCount(n, opts.maxMafia);
  const comp = { mafia: nMafia, doctor: 1, detective: 1 };
  let used = nMafia + 2;
  if (opts.vigilante && n > used) { comp.vigilante = 1; used++; }
  if (opts.jester && n > used) { comp.jester = 1; used++; }
  comp.villager = n - used;
  return comp;
}

/* Build and shuffle the role deck for n players. */
function buildRoleDeck(n, opts) {
  const comp = deckComposition(n, opts);
  const deck = [];
  Object.keys(comp).forEach(r => { for (let i = 0; i < comp[r]; i++) deck.push(r); });
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function roleSummary(n, opts) {
  const comp = deckComposition(n, opts);
  const parts = [];
  Object.keys(comp).forEach(r => {
    if (!comp[r]) return;
    parts.push(`${comp[r]} ${ROLES[r].name}${comp[r] > 1 && r === 'villager' ? 's' : ''}`);
  });
  return parts.join(' · ');
}
