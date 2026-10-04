import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGameService, OFFLINE_AFTER_MS, ROOM_IDLE_TTL_MS } from '../lib/game-service.mjs';
import { roomKey } from '../lib/room-storage.mjs';

function harness() {
  let time = 1_000_000;
  let version = 0;
  let writes = 0;
  let conflicts = 0;
  const data = new Map();
  const store = {
    async getWithMetadata(key, options) {
      assert.deepEqual(options, { type: 'json', consistency: 'strong' });
      const record = data.get(key);
      await Promise.resolve();
      return record ? structuredClone(record) : null;
    },
    async setJSON(key, value, options) {
      assert.equal(Boolean(options.onlyIfNew) !== Boolean(options.onlyIfMatch), true);
      await Promise.resolve();
      const previous = data.get(key);
      if ((options.onlyIfNew && previous) || (options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)) {
        conflicts++;
        return { modified: false };
      }
      writes++;
      const etag = `v${++version}`;
      data.set(key, { data: structuredClone(value), etag });
      return { modified: true, etag };
    },
  };
  // A new service instance for every request proves that process memory is irrelevant.
  const request = (input, token) => createGameService({ store, now: () => time, sleep: async () => {} })(input, token);
  const create = (overrides = {}) => request({ op: 'create', requestId: randomUUID(), nickname: 'Host', color: 'lime', ...overrides });
  const join = (room, overrides = {}) => request({ op: 'join', room, requestId: randomUUID(), nickname: 'Guest', color: 'violet', ...overrides });
  const action = (seat, action, value = {}, overrides = {}) => request({ op: 'action', room: seat.room, requestId: randomUUID(), action, data: value, ...overrides }, seat.token);
  const poll = seat => request({ op: 'poll', room: seat.room }, seat.token);
  return { request, create, join, action, poll, data, advance: ms => time += ms, stats: () => ({ writes, conflicts }) };
}

async function twoPlayers(h) {
  const host = (await h.create()).body;
  const guest = (await h.join(host.room)).body;
  return { host, guest };
}

test('cold requests complete three rounds with exact streak scoring and a unique final winner', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  assert.equal((await h.action(host, 'settings', { rounds: 3 })).status, 200);
  let state = (await h.action(host, 'start')).body.state;
  for (const seat of [host, guest]) state = (await h.action(seat, 'vote', { id: state.round.id, choice: 'a' })).body.state;
  assert.equal(state.phase, 'reveal');
  assert.deepEqual(state.players.map(p => p.score), [100, 100]);
  state = (await h.action(host, 'next')).body.state;
  state = (await h.action(host, 'vote', { id: state.round.id, choice: 'b' })).body.state;
  for (const milliseconds of [8_000, 8_000, 4_001]) {
    h.advance(milliseconds);
    state = (await h.poll(host)).body.state;
    await h.poll(guest);
  }
  assert.equal(state.phase, 'reveal');
  assert.deepEqual(state.players.map(p => p.score), [225, 100]);
  assert.deepEqual(state.players.map(p => p.streak), [2, 0]);
  state = (await h.action(host, 'next')).body.state;
  for (const seat of [host, guest]) state = (await h.action(seat, 'vote', { id: state.round.id, choice: 'a' })).body.state;
  state = (await h.action(host, 'next')).body.state;
  assert.equal(state.phase, 'podium');
  assert.equal(state.roundIndex, 3);
  assert.deepEqual(state.players.map(p => p.score), [375, 200]);
  assert.equal([...state.players].sort((a, b) => b.score - a.score)[0].id, host.playerId);
});

test('concurrent creates with one request ID return one room and one seat', async () => {
  const h = harness();
  const requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.create({ requestId })));
  results.forEach(result => assert.equal(result.status, 200));
  assert.equal(new Set(results.map(result => result.body.token)).size, 1);
  assert.equal(h.data.size, 1);
  assert.equal(h.stats().conflicts > 0, true);
  const changed = await h.create({ requestId, nickname: 'Different' });
  assert.equal(changed.status, 409);
});

test('conditional writes resolve competing color reservations without duplicate seats', async () => {
  const h = harness();
  const host = (await h.create()).body;
  const results = await Promise.all([h.join(host.room), h.join(host.room, { nickname: 'Rival' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await h.poll(host)).body.state.players.length, 2);
});

test('concurrent secret votes are retained and award a round exactly once', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  const round = (await h.action(host, 'start')).body.state.round;
  const firstId = randomUUID();
  const first = await h.action(host, 'vote', { id: round.id, choice: 'a' }, { requestId: firstId });
  assert.equal(first.body.state.phase, 'voting');
  const hidden = (await h.poll(guest)).body.state;
  assert.equal(hidden.round.myVote, null);
  assert.equal('votes' in hidden.round, false);
  assert.equal('result' in hidden.round, false);
  assert.equal(JSON.stringify(hidden).includes(host.token), false);
  const guestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => h.action(guest, 'vote', { id: round.id, choice: 'a' }, { requestId: guestId })));
  results.forEach(result => assert.equal(result.status, 200));
  const state = (await h.poll(host)).body.state;
  assert.equal(state.phase, 'reveal');
  assert.deepEqual(state.players.map(player => player.score), [100, 100]);
  const hostRetry = await h.action(host, 'vote', { id: round.id, choice: 'a' }, { requestId: firstId });
  assert.equal(hostRetry.status, 200);
  assert.equal(hostRetry.body.state.phase, 'reveal');
  assert.deepEqual(hostRetry.body.state.players.map(player => player.score), [100, 100]);
});

test('different players voting concurrently cannot overwrite one another', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  const round = (await h.action(host, 'start')).body.state.round;
  const results = await Promise.all([h.action(host, 'vote', { id: round.id, choice: 'a' }), h.action(guest, 'vote', { id: round.id, choice: 'b' })]);
  results.forEach(result => assert.equal(result.status, 200));
  const state = (await h.poll(host)).body.state;
  assert.equal(state.phase, 'reveal');
  assert.deepEqual(state.round.result.counts, { a: 1, b: 1 });
  assert.deepEqual(state.players.map(player => player.score), [0, 0]);
  assert.equal(h.stats().conflicts > 0, true);
});

test('an error after a deadline still persists the reveal and scores', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  const round = (await h.action(host, 'start')).body.state.round;
  await h.action(host, 'vote', { id: round.id, choice: 'a' });
  h.advance(20_001);
  const late = await h.action(guest, 'vote', { id: round.id, choice: 'b' });
  assert.equal(late.status, 409);
  const stored = h.data.get(roomKey(host.room)).data;
  assert.equal(stored.phase, 'reveal');
  assert.equal(stored.players.find(player => player.id === host.playerId).score, 100);
  assert.equal(stored.players.find(player => player.id === guest.playerId).score, 0);
  const state = (await h.poll(host)).body.state;
  assert.equal(state.round.result.total, 1);
  assert.equal(state.players.find(player => player.id === host.playerId).score, 100);
});

test('expired approval errors commit rejection lockout', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  const question = { prompt: 'Would you rather visit the moon or the ocean?', a: 'The moon', b: 'The ocean' };
  const ballot = (await h.action(host, 'submit', question)).body.state.ballot;
  h.advance(20_001);
  const response = await h.action(guest, 'approve', { id: ballot.id, approve: true });
  assert.equal(response.status, 409);
  assert.equal(h.data.get(roomKey(host.room)).data.rejected.length, 1);
  assert.equal((await h.action(host, 'submit', question)).status, 409);
});

test('heartbeat coalescing, offline seats and host transfer survive cold starts', async () => {
  const h = harness();
  const { host, guest } = await twoPlayers(h);
  const initialWrites = h.stats().writes;
  await h.poll(host);
  await h.poll(guest);
  assert.equal(h.stats().writes, initialWrites);
  h.advance(OFFLINE_AFTER_MS + 1);
  const state = (await h.poll(guest)).body.state;
  assert.equal(state.hostId, guest.playerId);
  assert.equal(state.players.find(player => player.id === host.playerId).connected, false);
  const returned = (await h.poll(host)).body.state;
  assert.equal(returned.hostId, guest.playerId);
  assert.equal(returned.players.find(player => player.id === host.playerId).connected, true);
  assert.equal(returned.players.find(player => player.id === host.playerId).color, 'lime');
});

test('all stale seats are excluded together before approval thresholds are evaluated', async () => {
  const h = harness();
  const { host } = await twoPlayers(h);
  const question = { prompt: 'Would you rather visit the moon or the ocean?', a: 'The moon', b: 'The ocean' };
  await h.action(host, 'submit', question);
  h.advance(OFFLINE_AFTER_MS + 1);
  await h.request({ op: 'lookup', room: host.room });
  const stored = h.data.get(roomKey(host.room)).data;
  assert.equal(stored.custom.length, 0);
  assert.ok(stored.ballot);
  assert.equal(stored.players.every(player => !player.connected), true);
});

test('leave and join receipts remain safe to retry and room credentials stay isolated', async () => {
  const h = harness();
  const host = (await h.create()).body;
  const requestId = randomUUID();
  const firstJoin = await h.join(host.room.toLowerCase(), { requestId });
  const secondJoin = await h.join(host.room.toLowerCase(), { requestId });
  assert.equal(firstJoin.body.token, secondJoin.body.token);
  const guest = firstJoin.body;
  const leaveId = randomUUID();
  const leave = await h.action(guest, 'leave', {}, { requestId: leaveId });
  assert.equal(leave.status, 200);
  const retry = await h.action(guest, 'leave', {}, { requestId: leaveId });
  assert.equal(retry.status, 200);
  assert.equal('state' in retry.body, false);
  const other = (await h.create()).body;
  const foreign = await h.request({ op: 'poll', room: other.room }, host.token);
  assert.equal(foreign.status, 401);
});

test('inactive rooms expire without any continuously running cleanup process', async () => {
  const h = harness();
  const host = (await h.create()).body;
  h.advance(ROOM_IDLE_TTL_MS + 1);
  assert.equal((await h.poll(host)).status, 404);
  assert.equal((await h.request({ op: 'lookup', room: host.room })).status, 404);
});

test('an existing room without a usable ETag fails closed before any write', async () => {
  for (const etag of [undefined, null, '', '   ', 123]) {
    const h = harness();
    const requestId = randomUUID();
    const host = (await h.create({ requestId })).body;
    const record = h.data.get(roomKey(host.room));
    record.etag = etag;
    const original = structuredClone(record.data);
    const writes = h.stats().writes;
    h.advance(15_000);
    const responses = [
      await h.poll(host),
      await h.action(host, 'settings', { theme: 'winter' }),
      await h.join(host.room),
      await h.create({ requestId }),
    ];
    for (const response of responses) {
      assert.equal(response.status, 503);
      assert.equal(response.body.error, 'The party server is busy. Please try again.');
    }
    assert.equal(h.stats().writes, writes);
    assert.deepEqual(record.data, original);
  }
});
