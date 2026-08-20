/* Role definitions and role assignment logic. Shared by host and player UIs. */

const ROLES = {
  /* ---------------- village ---------------- */
  villager: {
    id: 'villager', name: 'Villager', team: 'town', icon: '🧑‍🌾',
    desc: 'You are an innocent villager. Your vote and your ability to read people are your only weapons — help identify and eliminate the Mafia.',
    nightPrompt: null,
  },
  detective: {
    id: 'detective', name: 'Detective', team: 'town', icon: '🔍',
    desc: 'Each night, investigate one player to learn if they are Mafia. Beware: the Don will appear innocent.',
    nightPrompt: 'Choose someone to investigate tonight',
  },
  doctor: {
    id: 'doctor', name: 'Doctor', team: 'town', icon: '💉',
    desc: 'Each night, choose one player to protect from elimination. Your identity is secret.',
    nightPrompt: 'Choose someone to protect tonight',
  },
  mortician: {
    id: 'mortician', name: 'Mortician', team: 'town', icon: '⚰️',
    desc: 'Once per game, raise a fallen villager from the dead at dawn. Each night, choose whom to raise — or wait and save your power for later.',
    nightPrompt: 'Raise a fallen villager — or wait',
  },
  watcher: {
    id: 'watcher', name: 'Watcher', team: 'town', icon: '🪟',
    desc: 'You couldn’t sleep. From your window, you watched the street. Each night, pick one player — at dawn, you learn who came to their door.',
    nightPrompt: 'Choose whose door to watch tonight',
  },
  bodyguard: {
    id: 'bodyguard', name: 'Bodyguard', team: 'town', icon: '🛡️',
    desc: 'Someone’s paying you to keep them breathing. Each night, pick a player. If the Mafia comes for them, you take the bullet instead.',
    nightPrompt: 'Choose someone to guard tonight',
  },
  vigilante: {
    id: 'vigilante', name: 'Vigilante', team: 'town', icon: '🔫',
    desc: 'Two bullets. No badge. Don’t waste either. From Night 2, you may shoot one player each night — but gun down a fellow villager, and guilt holsters whatever is left for good.',
    nightPrompt: 'Shoot someone — or hold your fire',
  },
  tracker: {
    id: 'tracker', name: 'Tracker', team: 'town', icon: '👣',
    desc: 'You know how to follow someone without being seen. Each night, pick one player and shadow them — at dawn, you learn who they went to visit, if anyone.',
    nightPrompt: 'Choose someone to follow tonight',
  },
  coroner: {
    id: 'coroner', name: 'Coroner', team: 'town', icon: '🔬',
    desc: 'The town buries its dead without reading them — you don’t. Each night, examine one body in the morgue. At dawn, you alone learn exactly who they were.',
    nightPrompt: 'Choose a body to examine tonight',
  },
  bookkeeper: {
    id: 'bookkeeper', name: 'Bookkeeper', team: 'town', icon: '📒',
    desc: 'The ledger has to balance. Every dawn you know exactly how many of the Mafia are still breathing — never which of them. When the town buries the wrong person, you are the only one who knows.',
    nightPrompt: null,
  },
  mayor: {
    id: 'mayor', name: 'Mayor', team: 'town', icon: '🎖️',
    desc: 'City hall knows you; the town doesn’t. Once per game, at night, pledge to go public — at dawn the whole town hears it: you’re proven village and your vote counts double from then on. But everyone will know exactly who to silence.',
    nightPrompt: 'Go public — or stay quiet',
  },

  /* ---------------- mafia ---------------- */
  mafia: {
    id: 'mafia', name: 'Mafia', team: 'mafia', icon: '🔪',
    desc: 'You are Mafia. You know your teammates. Each night, vote with your team to eliminate a villager. Win when the mafia equal or outnumber everyone else.',
    nightPrompt: 'Choose someone to eliminate tonight',
  },
  don: {
    id: 'don', name: 'Don', team: 'mafia', icon: '🎩',
    desc: 'You are the Mafia Don. You lead the family’s nightly kill — and you appear innocent to the Detective. Use this to your advantage.',
    nightPrompt: 'Choose someone to eliminate tonight',
  },
  fixer: {
    id: 'fixer', name: 'Fixer', team: 'mafia', icon: '🔧',
    desc: 'You are the Mafia Fixer. You know the family and win when the mafia wins — but you don’t kill. Each night, pick one player outside the mafia: their night action will be prevented.',
    nightPrompt: 'Choose whose night action to prevent',
  },
  framer: {
    id: 'framer', name: 'Framer', team: 'mafia', icon: '🖼️',
    desc: 'You are the Mafia Framer. You know the family and win when the mafia wins — but you don’t kill. Each night, plant evidence on one player outside the mafia: if the Detective investigates them tonight, they’ll read as Mafia.',
    nightPrompt: 'Choose someone to frame tonight',
  },
  poisoner: {
    id: 'poisoner', name: 'Poisoner', team: 'mafia', icon: '☠️',
    desc: 'You are the Mafia Poisoner. You know the family and win when the mafia wins — but you don’t kill directly. Each night, poison one player outside the mafia. The victim is told they’ve been poisoned: if the Doctor doesn’t heal them the following night, they die at dawn. Only the death is announced.',
    nightPrompt: 'Choose someone to poison tonight',
  },
  consigliere: {
    id: 'consigliere', name: 'Consigliere', team: 'mafia', icon: '🧠',
    desc: 'You are the Mafia Consigliere. You know the family and win when the mafia wins — but you don’t kill. Each night, investigate one player outside the mafia to learn their exact role.',
    nightPrompt: 'Choose someone to investigate tonight',
  },
  forger: {
    id: 'forger', name: 'Forger', team: 'mafia', icon: '✒️',
    desc: 'You are the Mafia Forger. You know the family and win when the mafia wins — but you don’t kill. You get two forgeries for the whole game: pick a player outside the mafia, and if their last words are ever revealed, they’re destroyed instead.',
    nightPrompt: 'Mark someone’s last words for destruction — or wait',
  },
  cleaner: {
    id: 'cleaner', name: 'Cleaner', team: 'mafia', icon: '🧹',
    desc: 'You are the Mafia Cleaner. You know the family and win when the mafia wins — but you don’t kill. Twice a game, mark the family’s victim: their body is found with no role on it, and only you learn who they were.',
    nightPrompt: 'Clean tonight’s kill — or wait',
  },
  recruiter: {
    id: 'recruiter', name: 'Recruiter', team: 'mafia', icon: '🤝',
    desc: 'You are the Mafia Recruiter. One offer for the whole game: from the second night on, spend a night turning a villager instead of killing one. They wake up on your side, and nobody hears a thing.',
    nightPrompt: 'Make the offer — or wait',
  },

  /* ---------------- neutral ---------------- */
  jester: {
    id: 'jester', name: 'Jester', team: 'jester', icon: '🃏',
    desc: 'You are the Jester. Win by getting voted out during the day. You have no night action — just act suspicious. But not too suspicious.',
    nightPrompt: null,
  },
  executioner: {
    id: 'executioner', name: 'Executioner', team: 'jester', icon: '🪓',
    desc: 'You hold a personal grudge. Win if your target is voted out during the day — by anyone, for any reason. If they die any other way, you lose.',
    nightPrompt: null,
  },
  drifter: {
    id: 'drifter', name: 'Drifter', team: 'jester', icon: '🎒',
    desc: 'You’re just passing through. Win by being alive when the game ends — whoever else wins. Twice a game, lie low for the night and no blade or bullet can touch you.',
    nightPrompt: 'Lie low tonight — or sleep normally',
  },
};

const MIN_PLAYERS = 4;

/* Optional roles a host can enable, in the order they claim seats when the
 * player count allows (alternating town / mafia-support / neutral to keep
 * games roughly balanced as more are switched on). */
const OPTIONAL_ROLES = [
  'bodyguard', 'fixer', 'vigilante', 'framer', 'watcher', 'poisoner',
  'tracker', 'consigliere', 'coroner', 'cleaner', 'bookkeeper', 'forger',
  'mayor', 'recruiter', 'mortician', 'jester', 'executioner', 'drifter',
];

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

/* Which roles a game of n players gets, given the host's options.
 * opts.roles: {don: bool, bodyguard: bool, ...} for optional roles. */
function deckComposition(n, opts) {
  opts = opts || {};
  const en = opts.roles || {};
  const nMafia = mafiaCount(n, opts.maxMafia);
  const comp = {};
  // The Don replaces one ordinary mafia killer.
  if (en.don && nMafia >= 1) {
    comp.don = 1;
    if (nMafia > 1) comp.mafia = nMafia - 1;
  } else {
    comp.mafia = nMafia;
  }
  comp.doctor = 1;
  comp.detective = 1;
  let used = nMafia + 2;
  OPTIONAL_ROLES.forEach(r => {
    if (en[r] && n > used) { comp[r] = 1; used++; }
  });
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
