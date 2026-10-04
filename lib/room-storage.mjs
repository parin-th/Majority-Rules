// A room is the atomic unit of storage: votes, scores and retry receipts commit together.
export const ROOM_SCHEMA = 1;

export function encodeRoom(room) {
  return {
    ...room,
    schemaVersion: ROOM_SCHEMA,
    players: [...room.players.values()],
    rejected: [...room.rejected],
  };
}

export function decodeRoom(value) {
  if (!value || value.schemaVersion !== ROOM_SCHEMA || !Array.isArray(value.players) || !Array.isArray(value.rejected)) {
    throw new Error('Unsupported room record.');
  }
  return {
    ...value,
    players: new Map(value.players.map(player => [player.id, player])),
    rejected: new Set(value.rejected),
  };
}

export const roomKey = code => `rooms/${code}`;
