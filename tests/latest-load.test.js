import test from 'node:test';
import assert from 'node:assert/strict';
import { LatestLoad } from '../src/latest-load.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
function shuffled(length, seed) {
  const values = Array.from({ length }, (_, index) => index);
  let state = seed;
  for (let index = length - 1; index > 0; index--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const next = state % (index + 1);
    [values[index], values[next]] = [values[next], values[index]];
  }
  return values;
}

test('random completion order applies only the latest value and discards each stale resource once', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const changes = [], applied = [], discarded = new Map();
    const load = new LatestLoad({ onChange: () => changes.push(load.pending) });
    const requests = Array.from({ length: 9 }, (_, index) => ({ ...deferred(), value: { index } }));
    const results = requests.map(request => settle(load.run(() => request.promise, value => applied.push(value), {
      discard: value => discarded.set(value, (discarded.get(value) ?? 0) + 1),
    })));
    assert.equal(load.pending, true);
    let latestFinished = false;
    for (const index of shuffled(requests.length, seed)) {
      requests[index].resolve(requests[index].value);
      const result = await results[index];
      assert.deepEqual(result, { value: index === requests.length - 1 });
      latestFinished ||= index === requests.length - 1;
      assert.equal(load.pending, !latestFinished, `seed ${seed}, completion ${index}`);
    }
    assert.deepEqual(applied, [requests.at(-1).value]);
    assert.equal(discarded.size, requests.length - 1);
    for (const request of requests.slice(0, -1)) assert.equal(discarded.get(request.value), 1);
    assert.equal(discarded.has(requests.at(-1).value), false);
    assert.deepEqual(changes, [...requests.map(() => true), false]);
  }
});

test('random success and failure order silences stale failures but reports the current failure', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const load = new LatestLoad();
    const applied = [], discarded = [];
    const requests = Array.from({ length: 8 }, (_, index) => ({ ...deferred(), value: { index }, error: new Error(`read ${index}`) }));
    const failLatest = seed % 2 === 0;
    const fails = index => index === requests.length - 1 ? failLatest : (index + seed) % 3 === 0;
    const results = requests.map(request => settle(load.run(() => request.promise, value => applied.push(value), { discard: value => discarded.push(value) })));
    for (const index of shuffled(requests.length, seed * 17)) {
      const request = requests[index];
      if (fails(index)) request.reject(request.error); else request.resolve(request.value);
      const result = await results[index];
      if (index === requests.length - 1 && failLatest) assert.equal(result.error, request.error);
      else assert.deepEqual(result, { value: index === requests.length - 1 });
    }
    assert.deepEqual(applied, failLatest ? [] : [requests.at(-1).value]);
    assert.deepEqual(discarded.map(value => value.index).sort(), requests.slice(0, -1).filter(request => !fails(request.value.index)).map(request => request.value.index));
    assert.equal(load.pending, false);
  }
});

test('cancel then start again keeps the new pending state when an old read settles', async () => {
  for (const rejectOld of [false, true]) {
    const changes = [], applied = [], discarded = [];
    const load = new LatestLoad({ onChange: () => changes.push(load.pending) });
    const old = deferred(), next = deferred();
    const oldValue = { obsolete: true }, nextValue = { current: true };
    const first = settle(load.run(() => old.promise, value => applied.push(value), { discard: value => discarded.push(value) }));
    load.cancel();
    assert.equal(load.pending, false);
    const second = settle(load.run(() => next.promise, value => applied.push(value)));
    if (rejectOld) old.reject(new Error('old read failed')); else old.resolve(oldValue);
    assert.deepEqual(await first, { value: false });
    assert.equal(load.pending, true);
    assert.deepEqual(changes, [true, false, true]);
    assert.deepEqual(discarded, rejectOld ? [] : [oldValue]);
    next.resolve(nextValue);
    assert.deepEqual(await second, { value: true });
    assert.equal(load.pending, false);
    assert.deepEqual(applied, [nextValue]);
    assert.deepEqual(changes, [true, false, true, false]);
  }
});

test('repeated cancellation discards a late resource exactly once and never applies it', async () => {
  const load = new LatestLoad();
  const request = deferred(), value = { resource: 'GLTF' };
  const discarded = [];
  const result = load.run(() => request.promise, () => assert.fail('cancelled read applied'), { discard: item => discarded.push(item) });
  load.cancel(); load.cancel();
  request.resolve(value);
  assert.equal(await result, false);
  assert.deepEqual(discarded, [value]);
  assert.equal(load.pending, false);
});

test('current synchronous read or apply errors reject and release the pending state', async () => {
  const load = new LatestLoad();
  const readError = new Error('read failed'), applyError = new Error('apply failed');
  await assert.rejects(load.run(() => { throw readError; }, () => assert.fail('read failed')), error => error === readError);
  assert.equal(load.pending, false);
  await assert.rejects(load.run(() => 'value', () => { throw applyError; }), error => error === applyError);
  assert.equal(load.pending, false);
  const applied = [];
  assert.equal(await load.run(() => 'retry', value => applied.push(value)), true);
  assert.deepEqual(applied, ['retry']);
});

test('a replacement started synchronously during apply retains its own pending state', async () => {
  const load = new LatestLoad();
  const next = deferred();
  const applied = [];
  let second;
  assert.equal(await load.run(() => 'first', value => {
    applied.push(value);
    second = load.run(() => next.promise, item => applied.push(item));
  }), true);
  assert.equal(load.pending, true);
  next.resolve('second');
  assert.equal(await second, true);
  assert.deepEqual(applied, ['first', 'second']);
  assert.equal(load.pending, false);
});
