// انحدار المضيف (host regression):
// المنشئ هو المضيف دائماً. الانضمام / المغادرة / إعادة الاتصال / الاستئناف
// لا تنقل المضيف أبداً. النقل يكون فقط بنقل صريح أو بمغادرة/انقطاع المضيف
// بعد نافذة الاستئناف (90 ثانية).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, RESUME_WINDOW_MS } from '../server/rooms.js';

function setup() {
  const mgr = new RoomManager();
  const { room, player: host } = mgr.createRoom({ hostPlayer: { name: 'المنشئ' }, settings: {} });
  // في الإنتاج يعلّم index.js المنشئ متصلاً عند ربط سوكيت الإنشاء.
  mgr.playerConnected(room, host.id);
  return { mgr, room, host };
}

test('host stays the creator after 7 players join', () => {
  const { mgr, room, host } = setup();
  try {
    assert.equal(room.hostId, host.id);
    assert.equal(room.creatorId, host.id);
    const joiners = [];
    for (let i = 1; i <= 7; i++) {
      const { player } = mgr.joinRoom(room.code, { name: `لاعب ${i}` });
      joiners.push(player);
      assert.equal(room.hostId, host.id, `host changed after join #${i} (${player.name})`);
      assert.equal(room.creatorId, host.id, `creatorId changed after join #${i}`);
    }
    assert.equal(mgr.connectedPlayers(room).length, 8);
    return;
  } finally {
    mgr.destroy();
  }
});

test('host stays after a non-host leaves and after a joiner rejoins/resumes', () => {
  const { mgr, room, host } = setup();
  try {
    const j1 = mgr.joinRoom(room.code, { name: 'لاعب 1' }).player;
    const j2 = mgr.joinRoom(room.code, { name: 'لاعب 2' }).player;
    // لاعب غير مضيف يغادر صراحةً.
    mgr.leaveRoom(room, j1.id);
    assert.equal(room.hostId, host.id, 'host changed after non-host leave');
    // لاعب ينقطع ثم يستأنف مقعده بنفس playerId + secret.
    mgr.disconnectPlayer(room, j2.id);
    assert.equal(room.hostId, host.id, 'host changed after joiner disconnect');
    const resumed = mgr.joinRoom(room.code, { name: 'لاعب 2', playerId: j2.id, secret: j2.secret });
    assert.equal(resumed.resumed, true, 'resume did not happen');
    assert.equal(room.hostId, host.id, 'host changed after joiner resume');
  } finally {
    mgr.destroy();
  }
});

test('host disconnect inside the 90s grace keeps the host; reconnect restores it', () => {
  const { mgr, room, host } = setup();
  try {
    mgr.joinRoom(room.code, { name: 'لاعب 1' });
    mgr.disconnectPlayer(room, host.id);
    assert.equal(room.hostId, host.id, 'host transferred on transient disconnect');
    assert.ok(room.hostGraceTimer, 'no host grace timer scheduled');
    // عودة المضيف خلال النافذة.
    mgr.playerConnected(room, host.id);
    assert.equal(room.hostId, host.id);
    assert.equal(room.hostGraceTimer, null, 'grace timer not cancelled on reconnect');
    assert.equal(room.hostDisconnectedAt, null);
  } finally {
    mgr.destroy();
  }
});

test('host transfers to the oldest connected player only after the 90s grace expires', () => {
  const { mgr, room, host } = setup();
  try {
    const j1 = mgr.joinRoom(room.code, { name: 'لاعب 1' }).player;
    mgr.joinRoom(room.code, { name: 'لاعب 2' });
    mgr.disconnectPlayer(room, host.id);
    assert.equal(room.hostId, host.id);
    // محاكاة مرور النافذة: اضبط وقت الانقطاع في الماضي ثم افحص المهلة.
    const hp = room.players.get(host.id);
    hp.disconnectedAt = Date.now() - RESUME_WINDOW_MS - 1000;
    mgr.checkHostGrace(room);
    assert.equal(room.hostId, j1.id, 'host did not transfer to oldest connected after grace');
    // المنضم الجديد بعد النقل لا يصبح مضيفاً.
    mgr.joinRoom(room.code, { name: 'لاعب 3' });
    assert.equal(room.hostId, j1.id);
  } finally {
    mgr.destroy();
  }
});

test('explicit host leave transfers immediately to the oldest connected player', () => {
  const { mgr, room, host } = setup();
  try {
    const j1 = mgr.joinRoom(room.code, { name: 'لاعب 1' }).player;
    mgr.joinRoom(room.code, { name: 'لاعب 2' });
    mgr.leaveRoom(room, host.id);
    assert.equal(room.hostId, j1.id, 'host did not transfer on explicit leave');
  } finally {
    mgr.destroy();
  }
});

test('explicit transfer_host moves the host, and later joins do not move it again', () => {
  const { mgr, room, host } = setup();
  try {
    const j1 = mgr.joinRoom(room.code, { name: 'لاعب 1' }).player;
    mgr.joinRoom(room.code, { name: 'لاعب 2' });
    mgr.transferHost(room, j1.id, host.id);
    assert.equal(room.hostId, j1.id);
    mgr.joinRoom(room.code, { name: 'لاعب 3' });
    assert.equal(room.hostId, j1.id, 'host changed after a join following explicit transfer');
    // غير المضيف لا يستطيع النقل.
    const j2 = [...room.players.values()].find((p) => p.name === 'لاعب 2');
    assert.throws(() => mgr.transferHost(room, j2.id, j2.id), (e) => e.code === 'not_host');
    assert.equal(room.hostId, j1.id);
  } finally {
    mgr.destroy();
  }
});
