// انحدار التمرير (scroll-to-top):
// showScreen() كان يستدعي window.scrollTo({top:0}) في كل مرة — بما فيها
// كل تحديث للوبي (room_snapshot) وكل سؤال — فأي نقرة كانت تعيد الصفحة للأعلى.
// القاعدة الآن: التمرير للأعلى فقط عند تغيير الشاشة فعلياً.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.dataset = {};
    this._classes = new Set();
    this.classList = {
      toggle: (name, force) => {
        if (force) this._classes.add(name);
        else this._classes.delete(name);
      },
      contains: (name) => this._classes.has(name),
    };
  }
}

test('showScreen scrolls to top only when the screen actually changes', async () => {
  const els = {};
  const scrollCalls = [];
  globalThis.document = {
    getElementById: (id) => {
      if (!els[id]) els[id] = new FakeEl(id);
      return els[id];
    },
  };
  globalThis.window = {
    scrollTo: (opts) => { scrollCalls.push(opts); },
  };
  const { showScreen } = await import('../public/js/ui/screens.js');

  showScreen('lobby');
  assert.equal(scrollCalls.length, 1, 'first visit to lobby should scroll once');
  showScreen('lobby');
  showScreen('lobby');
  assert.equal(scrollCalls.length, 1, 're-rendering the same screen must not scroll');
  showScreen('play');
  assert.equal(scrollCalls.length, 2, 'changing screen should scroll once');
  showScreen('play');
  assert.equal(scrollCalls.length, 2, 're-rendering play must not scroll');
  // محاكاة تحديثات متتالية كما يحدث مع كل room_snapshot في اللوبي:
  showScreen('lobby');
  for (let i = 0; i < 10; i++) showScreen('lobby');
  assert.equal(scrollCalls.length, 3, 'repeated lobby snapshots must not scroll again');
  assert.equal(scrollCalls[0].top, 0);
  delete globalThis.document;
  delete globalThis.window;
});
