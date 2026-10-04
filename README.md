# Majority Rules: Seasonal Edition — Netlify-ready

## Publish by dragging one ZIP

1. Sign in to your Netlify account and open **https://app.netlify.com/drop**.
2. Drag **netlify-ready-game.zip** onto the drop zone.
3. Wait for Netlify to install the included locked dependencies, build the project, and publish it. Open the resulting `netlify.app` address.
4. Host a room and share **Invite friends**. Players can join from separate devices and networks.

Signing in before uploading is required for Netlify's automatic source build. Drop the complete project ZIP, not the `dist` folder or the individual `game.zip` verification artifact. If your team makes new projects private by default, set this game's visibility to public before inviting people outside the team.

No GitHub repository, terminal commands, user-created environment variables, API keys, or database provisioning are required. Netlify provides the function's Blobs access automatically. Usage is subject to your Netlify plan.

Current official deployment instructions: https://docs.netlify.com/start/quickstarts/netlify-drop-quickstart/

## Same game, hosted multiplayer

Create / Join → Lobby → Secret vote → Majority reveal → Next round → Final podium → Play again.

- 2–8 players; six-character case-insensitive room codes and 20 exclusive avatar colors.
- English, Español, and Français. Each player can change language independently. All 100 built-in questions and all interface messages are translated. Custom questions keep their original language.
- Five independent visual themes and five decks of 20 questions. The catalog supports up to 50 decks.
- 3, 5, 10, 15, or 20 rounds; five remains the default. Three is an additional quick-game option.
- Majority streaks earn 100 / 125 / 150 / 200 points, capped after four wins. Ties, minority votes, and missed votes earn zero and reset the streak.
- Standard rounds last 20 seconds. Every fourth is an 8-second Blitz; every fifth doubles the full score including the streak bonus. All active votes arriving closes the round immediately.
- The host advances reveals and starts replay. Replay keeps the same room, seats, colors, settings, custom questions, and rejection lockout.

## Custom questions and deck codes

Prompts accept 15–120 characters; choices accept 2–40 characters and must differ. Each question receives a 20-second approval ballot. The author's approval counts, and at least `ceil(2 × active players / 3)` approvals are required. Insufficient approvals at the deadline, or too many rejections to reach the threshold, reject the question for the entire room session.

Export saves approved questions in a portable `MR1.` Base64 deck code. Only the host can import; imported questions follow the same approval rules. Imports validate all questions before changing the room. Duplicate and previously rejected questions are skipped. Custom questions remain in their original language.

## Connection and persistence

Each browser tab stores its own private seat token in session storage. Refreshing restores the same seat, score, color, and locked vote. For two players on one computer, open independent fresh tabs rather than duplicating an existing player's tab.

The browser polls the function for updates. If a player's heartbeat stops for 12 seconds, the next room request marks that seat inactive. Previously submitted votes still count. Host control transfers to a connected player; reconnecting does not take it back. Offline seats reserve their colors until the host releases them between matches.

Room state lives in Netlify Blobs and survives function restarts and normal deployments to the same site. Rooms expire after six hours without an authenticated player request. Expired room records are not automatically deleted; they are treated as closed and cannot be rejoined. Export custom questions if you want to keep them independently of a room.

Deadlines are absolute server timestamps. There is no continuously running timer: the next poll or action settles any elapsed deadline once. The visible countdown runs locally using the server clock. Under ordinary network conditions, other players see an update within one polling interval plus network latency.

## Project structure

- `netlify.toml`: build command, publish directory, standard function directory, and browser security headers. No redirects or custom function paths.
- `netlify/functions/game.ts`: the only deployed function. The frontend calls `/.netlify/functions/game` directly.
- `lib/`: persistence and request helpers, outside the functions directory.
- `engine.mjs`: authoritative gameplay rules, scoring, deadlines, approvals, and private player snapshots. Its room map is request-scoped only.
- `client.mjs`, `i18n.mjs`, `public/`, and `locales/`: editable frontend source, original visual design, and translations.
- `config.mjs` and `decks.json`: theme/color choices and extensible question catalog.
- `scripts/build.mjs`: validates translations and produces the optimized frontend in `dist/`.
- `scripts/package-function.mjs`: uses Netlify's official bundler to verify the deployable function archive.
- `artifacts/functions/game.zip`: verified function package; included for inspection, not uploaded separately.
- `package.json`, `package-lock.json`, `.nvmrc`: pinned dependencies and runtime selection.
- `test/`: gameplay, translation, persistence/concurrency, and packaged-function integration checks.
- `VERIFICATION.md`: results of the production build and gameplay verification.

Each room is one versioned Blobs record. Reads use strong consistency. Creation uses `onlyIfNew`; mutations use `onlyIfMatch` with the last-read ETag and retry on conflicts. This keeps simultaneous joins, votes, scoring, and custom ballots from overwriting each other. Mutation receipts make retries safe. Player tokens and opponents' secret choices are omitted from shared snapshots.

The ZIP excludes installed dependencies, caches, logs, and the old continuously running backend. Netlify builds the source and packages the function during publication. The included prebuilt frontend and function artifact were also verified locally; no live Netlify deployment is claimed.
