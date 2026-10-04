import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { ConditionalBlobsEmulator } from './helpers/blobs-emulator.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Read the actual official-bundler ZIP, not a second transpilation of the source.
// This intentionally needs no extra archive package or platform-specific command.
async function extractZip(archivePath, destination) {
  const archive = await readFile(archivePath);
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65_557) && archive.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'The function artifact must be a valid ZIP archive.');
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'Expected a ZIP directory entry.');
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(flags & 1, 0, 'Encrypted function artifacts are unsupported.');
    assert.ok(!name.includes('\\') && !name.split('/').includes('..'), 'Archive paths must be safe.');
    const target = resolve(destination, name);
    assert.ok(target.startsWith(resolve(destination) + sep), 'Archive entries must stay in their extraction directory.');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
    const dataStart = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    assert.ok(method === 0 || method === 8, 'Expected a stored or deflated ZIP entry.');
    const bytes = method === 0 ? compressed : inflateRawSync(compressed);
    assert.equal(bytes.length, size, `Complete ZIP entry: ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    names.push(name);
  }
  return names;
}

test('official packaged Function completes a real two-player, three-round game through Netlify Blobs', { timeout: 60_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'majority-rules-packaged-'));
  const previousBlobsContext = globalThis.netlifyBlobsContext;
  const originalFetch = globalThis.fetch;
  const transportWrites = [];
  const requests = [];
  const blobs = new ConditionalBlobsEmulator({
    directory: join(temporary, 'blobs'),
    port: 0,
    logger: () => {},
    onRequest: event => requests.push(event),
  });
  t.after(async () => {
    if (previousBlobsContext === undefined) delete globalThis.netlifyBlobsContext;
    else globalThis.netlifyBlobsContext = previousBlobsContext;
    globalThis.fetch = originalFetch;
    await blobs.stop();
    await rm(temporary, { recursive: true, force: true });
  });

  const metadata = JSON.parse(await readFile(join(project, 'artifacts/functions/verification.json'), 'utf8'));
  assert.equal(metadata.length, 1, 'Exactly one function must be packaged.');
  assert.equal(metadata[0].name, 'game');
  assert.equal(metadata[0].runtimeAPIVersion, 2, 'The packaged handler must use the standard Request/Response API.');
  const sourceFunctions = (await readdir(join(project, 'netlify/functions'))).filter(name => /\.[cm]?[jt]s$/u.test(name));
  assert.deepEqual(sourceFunctions, ['game.ts'], 'Helper modules must live outside the functions directory.');

  const extracted = join(temporary, 'function');
  const entries = await extractZip(join(project, 'artifacts/functions/game.zip'), extracted);
  const entry = entries.find(name => /(?:^|\/)game\.(?:mjs|js|cjs)$/u.test(name));
  assert.ok(entry, 'The actual archive must contain the game entrypoint.');
  const { port } = await blobs.start();
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init?.method || (input instanceof Request && input.method) || 'GET').toUpperCase();
    if (url.hostname === '127.0.0.1' && Number(url.port) === port && method === 'PUT') {
      transportWrites.push(new Headers(init?.headers || (input instanceof Request ? input.headers : undefined)));
    }
    return originalFetch(input, init);
  };
  // The SDK supports this runtime context global. It points only at the official
  // local emulator; no production hook, user credential, or environment variable.
  globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify({
    siteID: 'packaged-function-test',
    token: 'local-emulator-only',
    // A cached/default-consistency request must fail instead of quietly passing.
    edgeURL: 'http://127.0.0.1:1',
    uncachedEdgeURL: `http://127.0.0.1:${port}`,
  })).toString('base64');

  let invocation = 0;
  async function invoke(input, token, overrides = {}) {
    // A fresh module instance on every request proves rooms and round clocks
    // survive without a warm Function process or an in-memory game server.
    const bundleURL = pathToFileURL(join(extracted, entry));
    bundleURL.searchParams.set('invocation', String(++invocation));
    const { default: handler } = await import(bundleURL.href);
    assert.equal(typeof handler, 'function');
    const request = new Request('https://majority-rules.example/.netlify/functions/game', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input),
      ...overrides,
    });
    const response = await handler(request, {});
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-type'), /application\/json/u);
    return { status: response.status, body: await response.json() };
  }
  async function ok(input, token) {
    const result = await invoke(input, token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }
  const action = (player, action, data = {}) => ok({ op: 'action', room: player.room, action, data, requestId: randomUUID() }, player.token);
  const poll = player => ok({ op: 'poll', room: player.room }, player.token);
  const scoreOf = (state, player) => state.players.find(item => item.id === player.playerId);

  await t.test('HTTP method, origin, JSON, and bearer-token checks work in the shipped artifact', async () => {
    assert.equal((await invoke({}, null, { method: 'GET', body: undefined })).status, 405);
    assert.equal((await invoke({}, null, { headers: { 'content-type': 'application/json', origin: 'https://another.example' } })).status, 403);
    assert.equal((await invoke({}, null, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await invoke({}, null, { body: '{invalid' })).status, 400);
    assert.equal((await invoke({}, null, { body: JSON.stringify({ oversized: 'x'.repeat(120_000) }) })).status, 413);
  });

  const config = await ok({ op: 'config' });
  assert.equal(config.colors.length, 20);
  assert.equal(config.themes.length, 5);
  assert.equal(config.decks.reduce((count, deck) => count + deck.count, 0), 100);
  assert.ok(config.roundOptions.includes(3));
  const alice = await ok({ op: 'create', nickname: 'Alice', color: config.colors[0].id, requestId: randomUUID() });
  assert.match(alice.room, /^[A-Z0-9]{6}$/u);
  const bob = await ok({ op: 'join', room: alice.room.toLowerCase(), nickname: 'Bob', color: config.colors[1].id, requestId: randomUUID() });
  assert.equal(alice.room, bob.room);
  assert.notEqual(alice.token, bob.token);
  assert.equal((await invoke({ op: 'poll', room: alice.room }, 'wrong-token')).status, 401);
  assert.equal((await invoke({ op: 'action', room: bob.room, action: 'settings', data: { rounds: 3 }, requestId: randomUUID() }, bob.token)).status, 403);

  await action(alice, 'settings', { rounds: 3, theme: 'halloween', deck: 'general' });
  const submitted = await action(alice, 'submit', { prompt: 'Which party guest gets the last slice?', a: 'The host', b: 'The best dancer' });
  assert.equal(submitted.state.ballot.required, 2);
  await action(bob, 'approve', { id: submitted.state.ballot.id, approve: true });
  const beforeGame = (await poll(alice)).state;
  assert.equal(beforeGame.custom.length, 1);
  const exported = await action(alice, 'export');
  assert.match(exported.result.code, /^MR1\./u);

  let state = (await action(alice, 'start')).state;
  assert.equal(state.phase, 'voting');
  assert.equal(state.roundIndex, 1);
  assert.equal(state.round.duration, 20_000);
  assert.equal(state.round.question.custom, true);
  const firstRound = state.round.id;
  await action(alice, 'vote', { id: firstRound, choice: 'a' });
  const secret = (await poll(bob)).state;
  assert.equal(secret.phase, 'voting');
  assert.equal(secret.round.myVote, null);
  assert.equal(secret.round.votedCount, 1);
  assert.ok(!Object.hasOwn(secret.round, 'votes'), 'Other players must not see secret choices before reveal.');
  assert.ok(!Object.hasOwn(secret.round, 'result'));
  state = (await action(bob, 'vote', { id: firstRound, choice: 'a' })).state;
  assert.equal(state.phase, 'reveal', 'The second vote must fast-forward the countdown.');
  assert.ok(state.serverNow < state.round.deadline);
  assert.deepEqual(state.round.result.counts, { a: 2, b: 0 });
  assert.equal(scoreOf(state, alice).score, 100);
  assert.equal(scoreOf(state, bob).score, 100);
  assert.equal(scoreOf(state, alice).streak, 1);
  assert.equal(scoreOf(state, bob).streak, 1);

  state = (await action(alice, 'next')).state;
  assert.equal(state.roundIndex, 2);
  const secondRound = state.round.id;
  await action(alice, 'vote', { id: secondRound, choice: 'b' });
  state = (await action(bob, 'vote', { id: secondRound, choice: 'b' })).state;
  assert.equal(state.phase, 'reveal');
  assert.equal(state.round.result.awards[alice.playerId], 125);
  assert.equal(state.round.result.awards[bob.playerId], 125);
  assert.equal(scoreOf(state, alice).score, 225);
  assert.equal(scoreOf(state, bob).score, 225);
  assert.equal(scoreOf(state, alice).streak, 2);
  assert.equal(scoreOf(state, bob).streak, 2);

  state = (await action(alice, 'next')).state;
  assert.equal(state.roundIndex, 3);
  const deadline = state.round.deadline;
  await action(alice, 'vote', { id: state.round.id, choice: 'a' });
  // Bob deliberately abstains while both players remain connected. This waits
  // out the real production timer and produces a unique winner with two seats.
  while (Date.now() < deadline + 30) {
    await poll(alice);
    state = (await poll(bob)).state;
    assert.ok(state.players.every(player => player.connected));
    if (state.phase === 'reveal') break;
    await sleep(Math.min(1_000, Math.max(10, deadline + 30 - Date.now())));
  }
  state = (await poll(alice)).state;
  assert.equal(state.phase, 'reveal', 'A later invocation must reconcile the persisted deadline.');
  assert.ok(state.serverNow >= deadline);
  assert.deepEqual(state.round.result.counts, { a: 1, b: 0 });
  assert.equal(state.round.result.awards[alice.playerId], 150);
  assert.equal(state.round.result.awards[bob.playerId], 0);
  assert.equal(scoreOf(state, alice).score, 375);
  assert.equal(scoreOf(state, bob).score, 225);
  assert.equal(scoreOf(state, alice).streak, 3);
  assert.equal(scoreOf(state, bob).streak, 0);

  const podium = (await action(alice, 'next')).state;
  const otherPodium = (await poll(bob)).state;
  for (const result of [podium, otherPodium]) {
    assert.equal(result.phase, 'podium');
    assert.equal(result.roundIndex, 3);
    const ranking = [...result.players].sort((a, b) => b.score - a.score);
    assert.equal(ranking[0].nickname, 'Alice');
    assert.equal(ranking[0].score, 375);
    assert.equal(ranking[1].nickname, 'Bob');
    assert.equal(ranking[1].score, 225);
  }

  const replay = (await action(alice, 'replay')).state;
  assert.equal(replay.phase, 'lobby');
  assert.equal(replay.settings.rounds, 3);
  assert.deepEqual(replay.custom, beforeGame.custom);
  assert.deepEqual(replay.players.map(({ id, color }) => ({ id, color })), beforeGame.players.map(({ id, color }) => ({ id, color })));
  assert.ok(replay.players.every(player => player.connected && player.score === 0 && player.streak === 0));
  assert.equal((await poll(bob)).state.phase, 'lobby');
  assert.ok(requests.some(request => request.type === 'get'), 'The packaged SDK must read from the real Blobs emulator.');
  assert.ok(requests.some(request => request.type === 'set'), 'The packaged SDK must persist game changes to Blobs.');
  assert.ok(transportWrites.some(headers => headers.get('if-none-match') === '*'), 'Room creation must use an atomic create-only write.');
  assert.ok(transportWrites.some(headers => headers.has('if-match')), 'Room changes must use a conditional ETag write.');
  assert.ok(transportWrites.every(headers => headers.get('if-none-match') === '*' || headers.has('if-match')), 'Every persisted room write must be conditional.');
  t.diagnostic(`Verified ${invocation} fresh packaged-Function invocations and ${requests.length} Blobs requests; final winner Alice 375, Bob 225.`);
});
