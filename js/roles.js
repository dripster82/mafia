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

/* Build and shuffle the role deck for n players. */
function buildRoleDeck(n, maxMafia) {
  const deck = [];
  const nMafia = mafiaCount(n, maxMafia);
  for (let i = 0; i < nMafia; i++) deck.push('mafia');
  deck.push('doctor');
  deck.push('detective');
  while (deck.length < n) deck.push('villager');
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function roleSummary(n, maxMafia) {
  const nMafia = mafiaCount(n, maxMafia);
  const nVillagers = n - nMafia - 2;
  const parts = [`${nMafia} Mafia`, '1 Doctor', '1 Detective'];
  if (nVillagers > 0) parts.push(`${nVillagers} Villager${nVillagers > 1 ? 's' : ''}`);
  return parts.join(' · ');
}
