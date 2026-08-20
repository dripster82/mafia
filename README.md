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
2. Everyone else opens the same site, taps **Join a game**, and enters the code and their name — or scans the host's **QR code**, which opens a pretty invite link (`…/CODES`) with the code pre-filled.
3. The host taps **Start game** (4+ players including the host). Everyone secretly receives a role — tap the card to peek, then confirm.
4. **Night:** the mafia agree on a victim, the Doctor protects, the Detective investigates, every other power role does its thing. Villagers sleep.
5. **Day:** everyone learns who died (or was wounded, saved, cured, or raised), discusses in person or in the built-in chat, then votes to eliminate someone — or no one. A **majority** is needed to eliminate; ties eliminate no one.
6. Repeat until the town eliminates all mafia, or the mafia equal the rest of the town — with the Jester, Executioner, and Drifter chasing their own wins on the side.

Roles stay hidden until a player dies or the game ends — including from the
host, who plays like everyone else. Mafia members always see each other's
role icons (in the vote list, players list, and night panel), along with a
☠️ mark on anyone currently poisoned.
The host's screen adds a small controls panel (start, force-advance for stuck
players, kick in the lobby, play again) showing only public information.

## Features

### Public games

Hosts can tick **🌐 Public game** (right under the room code and QR) to list
the room on the join page, where anyone on the same site sees who's waiting
("🦊 Paul, 🐸 Zoe · 🤖×3") and joins with one tap. Games are private by
default; listings refresh within seconds as the lobby changes, withdraw the
moment the game starts or the host's tab closes, and fade out within ~90
seconds after a hard crash.

The directory is a topic on [ntfy.sh](https://ntfy.sh) (a free, open pub/sub
service) — no accounts or keys. The topic name is derived from the site's
hostname (see `LOBBY_URL` at the bottom of `js/roles.js`), so forks
automatically get their own separate list; override `window.MAFIA_LOBBY_URL`
to point at a different topic, a self-hosted ntfy server, or a local stub.

### Table talk

- **Chat** during the lobby and every day phase; history carries across rounds
  with a `—— Round N ——` divider.
- **🔪 Family chat** — a private mafia channel, open **day and night**, for
  agreeing kills and coordinating misdirection. Recruits join it too.
- **👻 Ghost whispers** — the dead can keep talking in the main chat, but only
  other dead players see their messages.
- A floating **"New messages" pill** appears when chat updates off-screen.

### Bots (solo & fill-in play)

Add 🤖 bots from the lobby to fill seats or to play completely solo (solo games
let you pick your own role and show a live **bot suspicion debug panel**).
Bots act with human-like delays and:

- keep **individual opinions** of every player (per-bot suspicion, credulity,
  and "heat"), listen to the table, answer when addressed, and defend
  themselves when accused;
- **wait for the chat to go quiet** (6s) before voting, vote what they said
  they'd vote, and announce it when the discussion changes their mind;
- **re-read the record when someone dies**: a dead detective's accusations
  become gospel, exposed liars get called out, vote-blocs with dead mafia look
  dirty;
- play their roles: mafia bots fake detective claims, real bot detectives
  counter false ones, vigilante bots actually use their bullets, support
  mafia don't waste abilities on the night's kill target, poisoned bots beg
  for the doctor.

### Host options

- Safe first night (victims are only wounded) — default on
- Max mafia count (default 1, or auto ≈ ¼ of players)
- Show voters / secret ballot
- Doctor can't self-heal
- 👻 Ghost vote — the dead get one last vote, savable for a later day
- 😴 Night waiting roster — after 10 seconds, name who the night is still
  waiting on (hints at who holds a night role)
- 🪦 Last words on/off (the Forger needs this **on**)
- Reveal roles on death on/off (the Coroner and Bookkeeper need this **off** —
  their intel replaces the public reveals)
- Night timer & discussion timer

Role options that depend on a setting drag it into place automatically, and
turning the setting away unticks the roles.

### Quality of life

- **Host resume** — the game snapshots itself locally on every change; if the
  host's browser reloads mid-game, the home screen offers **Resume game**:
  same room code, bots intact, players reconnect automatically.
- Live **vote pressure** line ("2 more votes would eliminate X") with the
  leading candidate highlighted; a 2-second lock-in pause once all votes land.
- **Last words** from eliminated players (the town waits for them), verdict
  and dawn banners, day/night transition animations, sound chimes, mute
  toggle, and vibration on your turn (where the phone supports it).
- Day-1 **rumours** so the first discussion has something to chew on.
- 📖 **In-app role guide** on every screen.
- 📋 **Copy result summary** on the game-over screen, plus a full recap of
  every player's night actions.
- Join-side **debug log + ICE probe** (with copy button) for diagnosing
  connection problems.

### Roles

Core: 🔪 Mafia, 💉 Doctor, 🔍 Detective, 🧑‍🌾 Villager. The host can enable
extra roles per game:

- **Village:** 🛡️ Bodyguard (dies in the target's place — and always learns
  when they took a hit, even if the Doctor saved them), 🔫 Vigilante (two
  bullets from Night 2; killing town holsters the gun), 🪟 Watcher (sees who
  visited someone), 👣 Tracker (sees who someone visited), 🔬 Coroner (reads
  a body's true role), 📒 Bookkeeper (nightly count of living mafia),
  🎖️ Mayor (go public once: proven village, double vote), ⚰️ Mortician
  (raise one dead villager — the ritual completes even if the Mortician is
  killed that same night, and a failed ritual is always reported).
- **Mafia:** 🎩 Don (reads innocent to the Detective), 🔧 Fixer (blocks a
  night action — blocked players are told, and the recap marks it), 🖼️ Framer
  (frames someone as mafia), ☠️ Poisoner (the victim is told they're poisoned
  and dies the next dawn unless the Doctor heals them; only the death is
  announced — but a cure is: "The doctor saved X from the poison!"),
  🧠 Consigliere (learns exact roles),
  ✒️ Forger (destroys last words, twice), 🧹 Cleaner (hides a victim's role,
  twice), 🤝 Recruiter (turns a villager once).
- **Neutral:** 🃏 Jester (wins by being voted out), 🪓 Executioner (wins if
  their personal target is voted out), 🎒 Drifter (wins by surviving; can lie
  low twice).

## Deploying to GitHub Pages

This repo includes a workflow (`.github/workflows/pages.yml`) that deploys the
site on every push to `main` (it also stamps the commit hash into the page as
a version marker / cache-buster):

1. In the repo, go to **Settings → Pages** and set **Source** to the
   `gh-pages` branch (the workflow creates and force-pushes it).
2. Merge/push to `main`.
3. The game is live at `https://<user>.github.io/<repo>/`.

## Using your own TURN server

WebRTC connects devices directly when it can (via the STUN servers), but many
real-world networks — cellular carriers, guest Wi-Fi, hotel networks — block
direct connections. Those players can only connect through a **TURN relay**,
which forwards the traffic. This repo ships pointed at a
[Metered](https://www.metered.ca/) free-tier TURN account; **fork the repo and
swap in your own** so your games don't depend on someone else's quota.

All the connection settings live at the top of **`js/roles.js`**:

```js
const TURN_USER = '...'; // ← replace with your TURN username
const TURN_PASS = '...'; // ← replace with your TURN credential

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80',                username: TURN_USER, credential: TURN_PASS },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp',  username: TURN_USER, credential: TURN_PASS },
      { urls: 'turn:global.relay.metered.ca:443',               username: TURN_USER, credential: TURN_PASS },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS },
    ],
  },
};
```

To swap providers:

1. **Get TURN credentials.** The easiest route is a free
   [Metered](https://dashboard.metered.ca/signup) account (50 GB/month at the
   time of writing) — create a "TURN credential" and copy its **username** and
   **password**. Alternatives: [Twilio NTS](https://www.twilio.com/stun-turn),
   [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/), or
   self-hosting [coturn](https://github.com/coturn/coturn) on a small VPS.
2. **Edit `js/roles.js`:** set `TURN_USER` / `TURN_PASS`, and replace the
   `turn:`/`turns:` URLs with the ones your provider gives you. Keep at least
   one `turns:…:443?transport=tcp` entry — TLS over port 443 is the variant
   that survives the most restrictive networks. Leave the Google STUN entries;
   they're free and handle the easy cases without relaying.
3. **Push to `main`** and let the Pages workflow deploy.

Notes on credentials:

- The TURN username/password in `roles.js` are **meant to be client-visible**
  (every WebRTC app ships them to the browser) — but anyone who reads your
  repo can burn your relay quota, so use a provider that lets you cap usage or
  rotate credentials. **Never** put a provider *API key* in the repo; only the
  TURN credential pair.
- Only players whose networks block direct connections consume TURN
  bandwidth; most games relay little or nothing.

For local development you can override the broker/ICE config without editing
files by defining `window.MAFIA_PEER_CONFIG` before the scripts load — e.g.
point it at a local `peerjs --port 9777` broker for offline testing.

## Notes & limitations

- The host's browser **is** the server. Keep the host device awake; if the
  page does reload, use **Resume game** on the home screen (players' phones
  reconnect automatically; a fully closed host browser can also resume within
  12 hours).
- The initial handshake uses PeerJS's free public broker; game traffic itself
  is peer-to-peer (or through your TURN relay).
- Heavily filtered networks may block WebRTC entirely — the join screen's
  debug log and ICE probe show what a struggling device can and can't reach.
