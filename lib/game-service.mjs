import { createHash, randomInt } from 'node:crypto';
import { GameEngine, GameError, DECKS, MAX_DECKS } from '../engine.mjs';
import { COLORS, THEMES } from '../config.mjs';
import { encodeRoom, decodeRoom, roomKey } from './room-storage.mjs';

export const HEARTBEAT_WRITE_MS = 2_000;
export const OFFLINE_AFTER_MS = 12_000;
export const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 12;
const MAX_RECEIPTS = 2_048;
const hash = value => createHash('sha256').update(value).digest('hex');
const requireValue = (condition, message, status = 400) => {
  if (!condition) throw new GameError(message, status);
};
const codeOf = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const idOf = value => {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/u.test(value), 'Please retry this action.', 400);
  return value;
};
const success = body => ({ status: 200, body });
const failed = error => ({ status: error.status || 500, body: { error: error.message } });

function candidateCode(requestId, index) {
  const bytes = createHash('sha256').update(`majority-rules:${requestId}:${index}`).digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...bytes.subarray(0, 6)].map(byte => alphabet[byte % alphabet.length]).join('');
}

function config() {
  return {
    colors: COLORS,
    themes: THEMES,
    decks: DECKS.map(({ id, title, description, questions }) => ({ id, title, description, count: questions.length })),
    deckCapacity: MAX_DECKS,
    roundOptions: [3, 5, 10, 15, 20],
    pollInterval: 1_000,
  };
}

function entry(engine, room, player) {
  return { room: room.code, token: player.token, playerId: player.id, state: engine.snapshot(room, player) };
}

function signature(input, token) {
  return hash(JSON.stringify([input.op, codeOf(input.room || input.code), input.nickname, input.color, input.action, input.data, hash(token || '')]));
}

function receiptFor(room, input, token) {
  const receipt = (room.receipts || []).find(item => item.id === input.requestId);
  if (receipt) requireValue(receipt.signature === signature(input, token), 'That request has already been used. Please try again.', 409);
  return receipt;
}

function remember(room, input, token, response, playerId) {
  room.receipts ||= [];
  room.receipts.push({
    id: input.requestId,
    signature: signature(input, token),
    status: response.status,
    // Snapshots are reconstructed on a retry, so old receipts never expose stale votes.
    body: response.status === 200 ? { ok: true, result: response.body.result ?? null } : response.body,
    playerId,
  });
  if (room.receipts.length > MAX_RECEIPTS) room.receipts.splice(0, room.receipts.length - MAX_RECEIPTS);
}

function rememberedResponse(engine, room, input, receipt) {
  if (receipt.status !== 200) return { status: receipt.status, body: receipt.body };
  const player = room.players.get(receipt.playerId);
  if (input.op === 'join') {
    requireValue(player, 'Your seat has expired. Please join again.', 401);
    return success(entry(engine, room, player));
  }
  return success({ ...receipt.body, ...(player ? { state: engine.snapshot(room, player) } : {}) });
}

/**
 * Reconcile persisted clocks when a request arrives. No process, timer or live
 * connection must survive a Function invocation. Mark all stale players before
 * recalculating approval thresholds to avoid transient majorities.
 */
function reconcile(engine, room, player, timestamp) {
  let visibleChange = false;
  if (player) {
    if (!player.connected) {
      player.connected = true;
      player.offlineAt = null;
      visibleChange = true;
    }
    if (timestamp - player.lastSeen >= HEARTBEAT_WRITE_MS || visibleChange) {
      player.lastSeen = timestamp;
      room.lastActivityAt = timestamp;
    }
  }
  for (const other of room.players.values()) {
    if (other.id !== player?.id && other.connected && timestamp - other.lastSeen >= OFFLINE_AFTER_MS) {
      other.connected = false;
      other.offlineAt = timestamp;
      visibleChange = true;
    }
  }
  const previousHost = room.hostId;
  engine.migrateHost(room);
  if (room.hostId !== previousHost) visibleChange = true;
  const previousBallot = room.ballot?.id;
  engine.evaluateBallot(room);
  if (room.ballot?.id !== previousBallot) visibleChange = true;
  const previousPhase = room.phase;
  if (room.phase === 'voting' && timestamp >= room.round.deadline) engine.reveal(room);
  else engine.maybeReveal(room);
  if (room.phase !== previousPhase) visibleChange = true;
  if (visibleChange) engine.emit(room);
}

/** Store is the Netlify Blobs Store interface, injected to test real CAS races. */
export function createGameService({ store, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  async function read(code) {
    const stored = await store.getWithMetadata(roomKey(code), { type: 'json', consistency: 'strong' });
    // Never let a missing ETag turn onlyIfMatch into an unconditional overwrite.
    if (stored) {
      requireValue(typeof stored.etag === 'string' && stored.etag.trim().length > 0, 'The party server is busy. Please try again.', 503);
    }
    return stored;
  }
  async function pause(attempt) {
    await sleep(Math.min(60, 4 * (attempt + 1)) + randomInt(6));
  }

  async function create(input) {
    const requestId = idOf(input.requestId);
    const createSignature = signature(input, '');
    for (let attempt = 0, index = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = candidateCode(requestId, index);
      const stored = await read(code);
      if (stored) {
        const room = decodeRoom(stored.data);
        if (room.creationRequest === hash(requestId)) {
          requireValue(room.creationSignature === createSignature, 'That request has already been used. Please try again.', 409);
          requireValue(now() - room.lastActivityAt < ROOM_IDLE_TTL_MS, 'Room not found. Check the six-character code.', 404);
          const engine = new GameEngine({ now });
          const player = room.players.get(room.creatorId);
          requireValue(player, 'Your seat has expired. Please join again.', 401);
          return success(entry(engine, room, player));
        }
        index++;
        continue;
      }
      const engine = new GameEngine({ now });
      const { room, p } = engine.create(input);
      room.code = code;
      room.creatorId = p.id;
      room.creationRequest = hash(requestId);
      room.creationSignature = createSignature;
      room.lastActivityAt = now();
      room.receipts = [];
      const written = await store.setJSON(roomKey(code), encodeRoom(room), { onlyIfNew: true });
      if (written.modified) return success(entry(engine, room, p));
      // Re-read the same candidate after a race; it may be this exact request.
      await pause(attempt);
    }
    throw new GameError('The party server is busy. Please try again.', 503);
  }

  async function transaction(input, token) {
    const code = codeOf(input.room || input.code);
    requireValue(/^[A-Z0-9]{6}$/u.test(code), 'Room not found. Check the six-character code.', 404);
    // Export is read-only; do not duplicate a potentially large deck in receipts.
    const mutating = input.op === 'join' || (input.op === 'action' && input.action !== 'export');
    if (mutating) idOf(input.requestId);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const stored = await read(code);
      requireValue(stored, 'Room not found. Check the six-character code.', 404);
      const room = decodeRoom(stored.data);
      const timestamp = now();
      requireValue(timestamp - room.lastActivityAt < ROOM_IDLE_TTL_MS, 'Room not found. Check the six-character code.', 404);
      const before = JSON.stringify(encodeRoom(room));
      const engine = new GameEngine({ now: () => timestamp });
      engine.rooms.set(code, room);
      const receipt = mutating ? receiptFor(room, input, token) : null;
      let player = null;
      if (input.op === 'poll' || input.op === 'action') {
        // A completed leave remains retryable even though its seat is gone.
        player = receipt ? room.players.get(receipt.playerId) : engine.player(room, token);
      }
      if (receipt && input.op === 'join') player = room.players.get(receipt.playerId);
      reconcile(engine, room, player, timestamp);

      let response;
      try {
        if (receipt) response = rememberedResponse(engine, room, input, receipt);
        else {
          if (input.op === 'lookup') response = success(engine.publicInfo(room));
          else if (input.op === 'poll') response = success({ state: engine.snapshot(room, player) });
          else if (input.op === 'join') {
            player = engine.join(code, input).p;
            engine.migrateHost(room);
            room.lastActivityAt = timestamp;
            response = success(entry(engine, room, player));
          } else if (input.op === 'action') {
            const result = engine.action(room, player, input.action, input.data);
            room.lastActivityAt = timestamp;
            response = success({ ok: true, result: result ?? null, ...(room.players.has(player.id) ? { state: engine.snapshot(room, player) } : {}) });
          } else throw new GameError('Unknown action.', 404);
        }
      } catch (error) {
        if (!(error instanceof GameError)) throw error;
        response = failed(error);
      }
      if (!receipt && mutating) remember(room, input, token, response, player?.id);

      const data = encodeRoom(room);
      if (JSON.stringify(data) === before) return response;
      const written = await store.setJSON(roomKey(code), data, { onlyIfMatch: stored.etag });
      if (written.modified) return response;
      // Always reload and reapply after contention; no stale room can overwrite a vote.
      await pause(attempt);
    }
    throw new GameError('Too many requests. Give it a moment and try again.', 429);
  }

  return async function game(input, token = '') {
    try {
      requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Please send valid question data.');
      if (input.op === 'action' && input.data !== undefined) {
        requireValue(input.data && typeof input.data === 'object' && !Array.isArray(input.data), 'Please send valid question data.');
      }
      if (input.op === 'config') return success(config());
      if (input.op === 'create') return await create(input);
      if (!['lookup', 'join', 'poll', 'action'].includes(input.op)) throw new GameError('Unknown action.', 404);
      return await transaction(input, token);
    } catch (error) {
      if (!(error instanceof GameError)) throw error;
      return failed(error);
    }
  };
}
