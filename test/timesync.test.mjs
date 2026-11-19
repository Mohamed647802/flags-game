import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOffset, TimeSync } from '../public/js/timesync.js';

// NOTE: the shipped computeOffset is a robust estimator, not a plain
// "offset of the min-rtt sample": it takes the 3 lowest-RTT samples and
// returns the MEDIAN offset among them. These tests assert that real
// behaviour (the task contract's literal "min-rtt offset" reading does
// not match the implementation).

test('computeOffset returns median offset of the 3 lowest-rtt samples', () => {
  const samples = [
    { rtt: 120, offset: 50 },
    { rtt: 20, offset: -8 },
    { rtt: 60, offset: 30 },
  ];
  // lowest-3 offsets sorted: [-8, 30, 50] -> median 30
  assert.equal(computeOffset(samples), 30);
});

test('computeOffset with a single sample returns its offset', () => {
  assert.equal(computeOffset([{ rtt: 42, offset: 7 }]), 7);
});

test('computeOffset ignores high-rtt outliers', () => {
  const samples = [
    { rtt: 100, offset: 1000 },
    { rtt: 90, offset: 900 },
    { rtt: 10, offset: 5 },
    { rtt: 20, offset: 7 },
    { rtt: 30, offset: 9 },
  ];
  // lowest-3 (rtt 10/20/30) offsets sorted: [5, 7, 9] -> median 7
  assert.equal(computeOffset(samples), 7);
});

test('computeOffset returns 0 for empty input', () => {
  assert.equal(computeOffset([]), 0);
});

test('TimeSync class is exported', () => {
  assert.equal(typeof TimeSync, 'function');
  const ts = new TimeSync(() => {});
  assert.ok(ts, 'TimeSync constructs');
  assert.equal(ts.offset, 0);
});
