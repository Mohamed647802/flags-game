// Room code tests against the real server/rooms.js API:
// - RoomManager#generateRoomCode() is an instance method (no static /
//   named export exists).
// - RoomManager#createRoom({ hostPlayer: { name }, settings }) returns
//   { room, player }; room.number is a per-manager sequence starting at 1001.
// - RoomManager#destroy() stops the sweep timer (it is unref'd anyway).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, ROOM_CODE_ALPHABET } from '../server/rooms.js';

const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const FORBIDDEN = new Set(['0', 'O', '1', 'I', 'L']);

test('room code alphabet excludes ambiguous characters', () => {
  assert.ok(ROOM_CODE_ALPHABET, 'ROOM_CODE_ALPHABET export missing');
  for (const ch of FORBIDDEN) {
    assert.ok(!ROOM_CODE_ALPHABET.includes(ch), `alphabet contains ambiguous char ${ch}`);
  }
  assert.equal(new Set(ROOM_CODE_ALPHABET).size, ROOM_CODE_ALPHABET.length);
});

test('generate 10,000 room codes: format, uniqueness, no ambiguous chars', () => {
  const mgr = new RoomManager();
  try {
    const codes = new Set();
    for (let i = 0; i < 10_000; i++) {
      const code = mgr.generateRoomCode();
      assert.equal(typeof code, 'string', `code #${i} is not a string`);
      assert.match(code, CODE_RE, `code ${code} does not match ${CODE_RE}`);
      for (const ch of code) assert.ok(!FORBIDDEN.has(ch), `code ${code} contains ambiguous char ${ch}`);
      assert.ok(!codes.has(code), `duplicate code ${code}`);
      codes.add(code);
    }
    assert.equal(codes.size, 10_000);
  } finally {
    mgr.destroy();
  }
});

test('createRoom: codes unique across 100 rooms and roomNumber increments', () => {
  const mgr = new RoomManager();
  try {
    const codes = new Set();
    const numbers = [];
    for (let i = 0; i < 100; i++) {
      const { room } = mgr.createRoom({ hostPlayer: { name: `Host ${i}` }, settings: {} });
      assert.ok(room?.code, `room #${i} has no code`);
      assert.match(room.code, CODE_RE, `room code ${room.code} bad format`);
      assert.ok(!codes.has(room.code), `duplicate room code ${room.code}`);
      codes.add(room.code);
      assert.equal(typeof room.number, 'number', `room #${i} has no numeric number field`);
      numbers.push(room.number);
    }
    assert.equal(codes.size, 100);
    assert.equal(mgr.roomCount(), 100);
    for (let i = 1; i < numbers.length; i++) {
      assert.ok(numbers[i] > numbers[i - 1],
        `room number did not increment: ${numbers[i - 1]} -> ${numbers[i]}`);
    }
  } finally {
    mgr.destroy();
  }
});

test('createRoom rejects an empty host name', () => {
  const mgr = new RoomManager();
  try {
    assert.throws(() => mgr.createRoom({ hostPlayer: { name: '   ' }, settings: {} }), /invalid_name|الاسم/);
  } finally {
    mgr.destroy();
  }
});
