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

1. Open the site on the host device and tap **Host a game** — you get a 5-letter room code.
2. Everyone else opens the same site, taps **Join a game**, and enters the code and their name.
3. The host taps **Start game** (4+ players). Everyone secretly receives a role — tap the card to peek.
4. **Night:** the Mafia pick a victim, the Doctor picks someone to protect, the Detective investigates someone. Villagers sleep.
5. **Day:** everyone learns who died (or was saved), discusses out loud, then votes to eliminate someone — or no one. Ties eliminate no one.
6. Repeat until the town eliminates all mafia, or the mafia equal the rest of the town.

Roles stay hidden until a player dies or the game ends. Dead players spectate.
The host is a neutral operator with a live progress view, force-advance controls
for stuck players, and an optional operator-only role reveal. To play as well,
the host can join from a second tab or device.

### Roles

| Role | Team | Night action |
|---|---|---|
| 🔪 Mafia (~1 per 4 players) | Mafia | Choose someone to eliminate (majority pick if several mafia) |
| 💉 Doctor | Town | Protect one person (self allowed) |
| 🔍 Detective | Town | Learn whether one person is mafia |
| 🧑‍🌾 Villager | Town | Sleep |

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
- Devices behind very restrictive NATs/firewalls may fail to connect (no TURN relay is configured).
