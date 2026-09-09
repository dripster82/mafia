/* Achievement catalog. The host awards single-game achievements during play
 * (see award()/finalizeAchievements() in host.js); cross-game ones (streaks,
 * career totals) are computed on each player's own device from their stats.
 * Unlocks live in localStorage per device. */

/* Display order, grouped with headers (general first, then one per role). */
const ACHIEVEMENT_GROUPS = [
  { title: '🏅 Winning', ids: ['first-blood', 'hat-trick', 'made-man', 'pillar', 'lone-wolf', 'sole-survivor', 'perfect-town', 'clean-sweep', 'full-house'] },
  { title: '💀 Dying Well', ids: ['boots-on', 'martyr', 'famous-last-words', 'vengeful-spirit', 'tough-crowd'] },
  { title: '🗳 Table Play', ids: ['chatterbox', 'kingmaker', 'bandwagon-driver', 'against-grain'] },
  { title: '🧑‍🌾 Villager', ids: ['just-a-farmer', 'voice-of-people', 'unremarkable'] },
  { title: '🔍 Detective', ids: ['gumshoe', 'framed', 'case-closed'] },
  { title: '💉 Doctor', ids: ['miracle-worker', 'antidote', 'heal-thyself'] },
  { title: '⚰️ Mortician', ids: ['necromancer', 'grave-concerns', 'too-late'] },
  { title: '🪟 Watcher', ids: ['neighbourhood-watch', 'eyes-everywhere'] },
  { title: '🛡 Bodyguard', ids: ['human-shield', 'not-on-my-watch', 'quiet-shift'] },
  { title: '🔫 Vigilante', ids: ['sharpshooter', 'friendly-fire', 'double-tap'] },
  { title: '👣 Tracker', ids: ['hot-pursuit', 'cold-trail'] },
  { title: '🔬 Coroner', ids: ['cause-of-death', 'full-morgue'] },
  { title: '📒 Bookkeeper', ids: ['long-audit', 'balanced-ledger'] },
  { title: '🎖 Mayor', ids: ['landslide', 'sitting-duck', 'silent-majority'] },
  { title: '🔪 Mafia & Don', ids: ['cold-blooded', 'bold-faced', 'don-abides', 'head-family'] },
  { title: '🔧 Fixer', ids: ['wrench-in-works', 'silenced-sleuth'] },
  { title: '🖼 Framer', ids: ['stitch-up', 'miscarriage'] },
  { title: '☠️ Poisoner', ids: ['slow-burn', 'serial-doser'] },
  { title: '🧠 Consigliere', ids: ['know-your-enemy', 'full-dossier'] },
  { title: '✒️ Forger', ids: ['ink-blot', 'wasted-ink'] },
  { title: '🧹 Cleaner', ids: ['spotless', 'deep-clean'] },
  { title: '🤝 Recruiter', ids: ['welcome-family', 'puppet-master'] },
  { title: '🃏 Jester', ids: ['curtain-call', 'tragic-comedy'] },
  { title: '🪓 Executioner', ids: ['grudge-settled', 'plans-ruined'] },
  { title: '🎒 Drifter', ids: ['nine-lives', 'ghost-town'] },
  { title: '🕶 Power Roles', ids: ['silent-service'] },
];

const ACHIEVEMENTS = {
  /* ---- winning ---- */
  'first-blood':    { icon: '🥇', name: 'First Blood', desc: 'Win your first game.' },
  'hat-trick':      { icon: '🎩', name: 'Hat Trick', desc: 'Win 3 games in a row.' },
  'made-man':       { icon: '🔪', name: 'Made Man', desc: 'Win 5 games on the mafia side.' },
  'pillar':         { icon: '🏘', name: 'Pillar of the Community', desc: 'Win 5 games on the village side.' },
  'lone-wolf':      { icon: '🐺', name: 'Lone Wolf', desc: 'Win as the Jester, Executioner, or Drifter.' },
  'sole-survivor':  { icon: '🏝', name: 'Sole Survivor', desc: 'Win as the last living member of your team.' },
  'perfect-town':   { icon: '✨', name: 'Perfect Town', desc: 'Win with the village without ever voting out an innocent.' },
  'clean-sweep':    { icon: '🧹', name: 'Clean Sweep', desc: 'Win as mafia with the whole family still breathing.' },
  'full-house':     { icon: '🎪', name: 'Full House', desc: 'Finish a game with 10 or more players.' },

  /* ---- dying well ---- */
  'boots-on':       { icon: '🥾', name: 'Died With Their Boots On', desc: 'Die on night 1 three games in a row.' },
  'martyr':         { icon: '🕯', name: 'Martyr', desc: 'Get voted out while innocent — and your team wins anyway.' },
  'famous-last-words': { icon: '🎤', name: 'Famous Last Words', desc: 'Leave last words for the whole table.' },
  'vengeful-spirit': { icon: '👻', name: 'Vengeful Spirit', desc: 'Your ghost vote helps eliminate a mafia member.' },
  'tough-crowd':    { icon: '🍅', name: 'Tough Crowd', desc: 'Get voted out on day 1.' },

  /* ---- table play ---- */
  'chatterbox':     { icon: '💬', name: 'Chatterbox', desc: 'Send 25 chat messages in one game.' },
  'kingmaker':      { icon: '👑', name: 'Kingmaker', desc: 'Cast the vote that tips a candidate over the majority.' },
  'bandwagon-driver': { icon: '🚂', name: 'Bandwagon Driver', desc: 'Be the first voter on someone who ends up eliminated.' },
  'against-grain':  { icon: '🧭', name: 'Against the Grain', desc: 'Vote for the real mafia while the town lynches an innocent.' },

  /* ---- villager ---- */
  'just-a-farmer':  { icon: '🧑‍🌾', name: 'Just a Farmer', desc: 'Win as a plain Villager.' },
  'voice-of-people': { icon: '📢', name: 'Voice of the People', desc: 'As a Villager, vote for actual mafia on 3 days of one game.' },
  'unremarkable':   { icon: '🫥', name: 'Unremarkable', desc: 'As a Villager, survive the whole game never attacked and never voted for.' },

  /* ---- detective ---- */
  'gumshoe':        { icon: '🔍', name: 'Gumshoe', desc: 'Identify a mafia member who then gets voted out.' },
  'framed':         { icon: '🖼', name: 'Framed!', desc: 'Investigate someone the Framer set up. You got played.' },
  'case-closed':    { icon: '🗂', name: 'Case Closed', desc: 'Investigate every living player in one game.' },

  /* ---- doctor ---- */
  'miracle-worker': { icon: '💉', name: 'Miracle Worker', desc: 'Save someone from the mafia’s attack.' },
  'antidote':       { icon: '💊', name: 'Antidote', desc: 'Cure a poisoned player.' },
  'heal-thyself':   { icon: '🩺', name: 'Physician, Heal Thyself', desc: 'Cure your own poisoning.' },

  /* ---- mortician ---- */
  'necromancer':    { icon: '⚰️', name: 'Necromancer', desc: 'Raise the dead.' },
  'grave-concerns': { icon: '🪦', name: 'Grave Concerns', desc: 'Raise a fallen power role.' },
  'too-late':       { icon: '⏳', name: 'Too Late', desc: 'Die with your revival unused.' },

  /* ---- watcher ---- */
  'neighbourhood-watch': { icon: '🪟', name: 'Neighbourhood Watch', desc: 'Catch a visitor at someone’s door.' },
  'eyes-everywhere': { icon: '👀', name: 'Eyes Everywhere', desc: 'Watch the victim’s door on the night of the kill.' },

  /* ---- bodyguard ---- */
  'human-shield':   { icon: '🛡', name: 'Human Shield', desc: 'Die taking the hit meant for your charge.' },
  'not-on-my-watch': { icon: '💪', name: 'Not On My Watch', desc: 'Take the hit for your charge — and survive it.' },
  'quiet-shift':    { icon: '🌙', name: 'Quiet Shift', desc: 'Guard for 3 nights without an attack coming.' },

  /* ---- vigilante ---- */
  'sharpshooter':   { icon: '🎯', name: 'Sharpshooter', desc: 'Shoot a mafia member.' },
  'friendly-fire':  { icon: '😬', name: 'Friendly Fire', desc: 'Shoot a villager. Oops.', shame: true },
  'double-tap':     { icon: '🔫', name: 'Double Tap', desc: 'Kill mafia with both bullets in one game.' },

  /* ---- tracker ---- */
  'hot-pursuit':    { icon: '👣', name: 'Hot Pursuit', desc: 'Follow someone straight to the night’s victim.' },
  'cold-trail':     { icon: '🥶', name: 'Cold Trail', desc: 'Three stay-at-home reports in one game.', shame: true },

  /* ---- coroner ---- */
  'cause-of-death': { icon: '🔬', name: 'Cause of Death', desc: 'Examine a body in the morgue.' },
  'full-morgue':    { icon: '🏥', name: 'Full Morgue', desc: 'Examine 3 bodies in one game.' },

  /* ---- bookkeeper ---- */
  'long-audit':     { icon: '📒', name: 'The Long Audit', desc: 'Receive 4 ledger reports in one game.' },
  'balanced-ledger': { icon: '🧾', name: 'Balanced Ledger', desc: 'Survive to a village win as the Bookkeeper.' },

  /* ---- mayor ---- */
  'landslide':      { icon: '🎖', name: 'Landslide', desc: 'Go public as Mayor and live to win.' },
  'sitting-duck':   { icon: '🦆', name: 'Sitting Duck', desc: 'Go public as Mayor — and die the very next night.', shame: true },
  'silent-majority': { icon: '🤫', name: 'Silent Majority', desc: 'Win as Mayor without ever going public.' },

  /* ---- mafia / don ---- */
  'cold-blooded':   { icon: '🧊', name: 'Cold Blooded', desc: 'Win as a mafia killer without ever receiving a vote.' },
  'bold-faced':     { icon: '🎭', name: 'Bold Faced', desc: 'Vote against your own family to sell the act — and win.' },
  'don-abides':     { icon: '🎩', name: 'The Don Abides', desc: 'Get investigated as the Don and go on to win.' },
  'head-family':    { icon: '👔', name: 'Head of the Family', desc: 'Win as the Don with two or more family members alive.' },

  /* ---- fixer ---- */
  'wrench-in-works': { icon: '🔧', name: 'Wrench in the Works', desc: 'Block a power role’s night action.' },
  'silenced-sleuth': { icon: '🤐', name: 'Silenced the Sleuth', desc: 'Block the Detective.' },

  /* ---- framer ---- */
  'stitch-up':      { icon: '🪡', name: 'Stitch-Up', desc: 'Your framed target gets investigated that same night.' },
  'miscarriage':    { icon: '⚖️', name: 'Miscarriage of Justice', desc: 'Your framed target is voted out while innocent.' },

  /* ---- poisoner ---- */
  'slow-burn':      { icon: '☠️', name: 'Slow Burn', desc: 'One of your poisonings runs its full course.' },
  'serial-doser':   { icon: '🧪', name: 'Serial Doser', desc: 'Poison 3 different players in one game.' },

  /* ---- consigliere ---- */
  'know-your-enemy': { icon: '🧠', name: 'Know Your Enemy', desc: 'Uncover a power role’s exact identity.' },
  'full-dossier':   { icon: '📁', name: 'Full Dossier', desc: 'Investigate 3 players in one game.' },

  /* ---- forger ---- */
  'ink-blot':       { icon: '✒️', name: 'Ink Blot', desc: 'Destroy someone’s last words.' },
  'wasted-ink':     { icon: '🖋', name: 'Wasted Ink', desc: 'Finish a game with both forgeries unused.', shame: true },

  /* ---- cleaner ---- */
  'spotless':       { icon: '🫧', name: 'Spotless', desc: 'Scrub a victim’s role from the record.' },
  'deep-clean':     { icon: '🧼', name: 'Deep Clean', desc: 'Clean two bodies in one game.' },

  /* ---- recruiter ---- */
  'welcome-family': { icon: '🤝', name: 'Welcome to the Family', desc: 'Successfully turn a villager.' },
  'puppet-master':  { icon: '🪢', name: 'Puppet Master', desc: 'Win with your recruit still alive.' },

  /* ---- jester ---- */
  'curtain-call':   { icon: '🃏', name: 'Curtain Call', desc: 'Win as the Jester — they actually voted for you.' },
  'tragic-comedy':  { icon: '😭', name: 'Tragic Comedy', desc: 'As the Jester, survive to the end. Nobody fell for it.', shame: true },

  /* ---- executioner ---- */
  'grudge-settled': { icon: '🪓', name: 'Grudge Settled', desc: 'The town votes out your personal target.' },
  'plans-ruined':   { icon: '📉', name: 'Plans Ruined', desc: 'Your grudge target dies some other way.', shame: true },

  /* ---- drifter ---- */
  'nine-lives':     { icon: '🐈', name: 'Nine Lives', desc: 'Survive an attack by lying low.' },
  'ghost-town':     { icon: '🎒', name: 'Ghost Town', desc: 'Use both lie-low nights in one game.' },

  /* ---- power roles in general ---- */
  'silent-service': { icon: '🕶', name: 'Silent Service', desc: 'Win with a village power role without ever being voted for.' },
};
