# 🕵️ Mafia Night

A browser-based operator for the classic **Mafia** party game (in the spirit of
the-perfect-murder.com). One device hosts a game, everyone else joins from their
own phone or laptop — no accounts, no backend, no installs.

**How it works:** the whole app is static HTML/JS, so it runs on GitHub Pages.
Player devices connect **directly to the host's browser** over WebRTC
([PeerJS](https://peerjs.com)); the host device holds the authoritative game
state and deals each player a private, personalized view. Roles never leave the
host except to the player who owns them.

## Playing

1. Open the site on the host device, tap **Host a game**, and enter your name — you get a 5-letter room code. The host plays too; the app itself is the neutral operator.
2. Everyone else opens the same site, taps **Join a game**, and enters the code and their name.
3. The host taps **Start game** (4+ players including the host). Everyone secretly receives a role — tap the card to peek.
4. **Night:** the Mafia pick a victim, the Doctor picks someone to protect, the Detective investigates someone. Villagers sleep.
5. **Day:** everyone learns who died (or was saved), discusses out loud, then votes to eliminate someone — or no one. Ties eliminate no one.
6. Repeat until the town eliminates all mafia, or the mafia equal the rest of the town.

Roles stay hidden until a player dies or the game ends — including from the
host, who plays like everyone else. Dead players spectate. The host's screen
adds a small controls panel (start, force-advance for stuck players, kick in
the lobby, play again) showing only public information.

### Roles

Core: 🔪 Mafia, 💉 Doctor, 🔍 Detective, 🧑‍🌾 Villager. The host can enable
extra roles per game:

- **Village:** 🛡️ Bodyguard (dies in the target's place), 🔫 Vigilante (two
  bullets from Night 2; killing town holsters the gun), 🪟 Watcher (sees who
  visited someone), 👣 Tracker (sees who someone visited), 🔬 Coroner (reads
  a body's true role), 📒 Bookkeeper (nightly count of living mafia),
  🎖️ Mayor (go public once: proven village, double vote), ⚰️ Mortician
  (raise one dead villager).
- **Mafia:** 🎩 Don (reads innocent to the Detective), 🔧 Fixer (blocks a
  night action), 🖼️ Framer (frames someone as mafia), ☠️ Poisoner (delayed
  kill unless healed the following night), 🧠 Consigliere (learns exact
  roles), ✒️ Forger (destroys last words, twice), 🧹 Cleaner (hides a
  victim's role, twice), 🤝 Recruiter (turns a villager once).
- **Neutral:** 🃏 Jester (wins by being voted out), 🪓 Executioner (wins if
  their personal target is voted out), 🎒 Drifter (wins by surviving; can lie
  low twice).

## Deploying to GitHub Pages

This repo includes a workflow (`.github/workflows/pages.yml`) that deploys the
site on every push to `main`:

1. In the repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Merge/push to `main`.
3. The game is live at `https://<user>.github.io/<repo>/`.

(Alternatively, set Pages to "Deploy from a branch" pointing at `main` / root.)

## Notes & limitations

- The host's browser **is** the server: if the host closes or reloads the page, the game is lost (players who reload can rejoin automatically).
- Connections use PeerJS's free public broker for the initial handshake; game traffic itself is peer-to-peer.
- Connections try direct peer-to-peer first (STUN) and fall back to a free public TURN relay (Open Relay), so devices on different networks — e.g. cellular vs Wi-Fi — can still connect. Heavily filtered networks may still block WebRTC entirely.
