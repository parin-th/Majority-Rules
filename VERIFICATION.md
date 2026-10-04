# Verification

Verified locally on 4 October 2026. No live Netlify deployment was performed.

## Production artifacts

- Installed pinned packages in a fresh build directory and generated the included npm lockfile.
- Built the optimized frontend successfully, including 252 interface messages and 100 built-in questions in each of English, Spanish, and French.
- Packaged the function with Netlify's official `@netlify/zip-it-and-ship-it` 16.2.3 bundler. Exactly one function was discovered: `game`, JavaScript runtime, standard API version 2.
- Extracted and executed the actual packaged handler, including its packaged Netlify Blobs SDK dependencies. The test imports a fresh handler module for every request.
- Frontend calls `/.netlify/functions/game` directly. No alternate API redirect, custom function path, continuously running game server, database credentials, or user-supplied environment variables.

## Complete two-player match

The packaged function was exercised through the real Netlify Blobs SDK and a local filesystem-backed Blobs emulator. Both players remained connected during the final deadline.

| Round | Alice | Bob | Alice total | Bob total |
|---|---|---|---:|---:|
| 1 | A, +100 | A, +100 | 100 | 100 |
| 2 | B, +125 | B, +125 | 225 | 225 |
| 3 | A, +150 | No vote, +0 | 375 | 225 |

The first two rounds fast-forwarded when both votes arrived. The third waited for the real 20-second deadline. Both players received the final podium with **Alice winning 375–225**. Bob's missed vote reset his streak. Play Again returned both players to the same room with colors, settings, and the approved custom question preserved.

This integration made 67 fresh packaged-function invocations and 97 Blobs requests. It checked secret votes, custom approval/export, HTTP validation, authorization, and replay. The cached storage endpoint was deliberately unavailable, proving the function used the strong-consistency endpoint. All room writes carried either `If-None-Match: *` or `If-Match`.

The same three-round match was also played through two independent browser tabs against the extracted packaged handler and optimized frontend. English, Spanish, and French appeared in the same room, with matching choices and scores. The browser showed Alice's 375–225 win on both podiums. Refresh restored the host's seat and final score.

## Automated checks

**53 passed, 0 failed.** Coverage includes:

- Five decks, 100 questions, 20 colors, 2–8 seats, isolated room codes, and host controls.
- Exact streak yields, cap, ties, missed votes, Blitz, double points, and fast-forward.
- 2/3 approval across all room sizes, deadline rejection, rejection lockout, Unicode deck round trips, validation, and imports.
- Concurrent room creation, color selection, and votes; conditional-write conflicts and request retries; no duplicate scoring.
- Persisted deadlines, error-side state changes, reconnects, heartbeat coalescing, host transfer, and room expiry.
- Refusing every write when an existing room has a missing or malformed ETag.
- Frontend endpoint, safe retry IDs, abort handling, revision ordering, and all translations.

## Local tooling notes

The official compiler's WebAssembly distribution is pinned through an npm alias/override for portable builds on this Windows environment. It uses the same compiler API and emits ordinary JavaScript. Netlify's production function source remains a standard TypeScript function.

Netlify Blobs SDK 11.1.3's local emulator omits ETags from GET responses and does not serialize its filesystem compare-and-write operations. The test-only helper in `test/helpers/blobs-emulator.mjs` adds the emulator's own ETag and serializes emulator requests to model documented production semantics. The real SDK still performs HTTP requests and the official emulator still validates conditional writes and persists files. This helper is excluded from the deployed function. Production code fails closed if Netlify returns a room without an ETag; there is no unconditional-write fallback.

Netlify's hosted service was not contacted for gameplay. Deployment, account settings, public visibility, and latency on separate physical devices should be checked on the URL Netlify creates after upload.
