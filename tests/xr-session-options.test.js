import test from 'node:test';
import assert from 'node:assert/strict';
import { xrInputMode, xrSessionOptions } from '../src/xr-session-options.js';

test('automatic input selection uses immersive VR support so Android-based HMDs retain controllers', () => {
  assert.equal(xrInputMode('auto', true), 'controller');
  assert.equal(xrInputMode('auto', false), 'touch');
  assert.equal(xrSessionOptions({mode: 'live', vrSupported: true}).inputMode, 'controller');
  assert.equal(xrSessionOptions({mode: 'live', vrSupported: false}).inputMode, 'touch');
});

test('an explicit input preference overrides automatic device selection', () => {
  assert.equal(xrInputMode('touch', true), 'touch');
  assert.equal(xrInputMode('controller', false), 'controller');
  assert.equal(xrSessionOptions({mode: 'live', preference: 'touch', vrSupported: true}).inputMode, 'touch');
  assert.equal(xrSessionOptions({mode: 'live', preference: 'controller', vrSupported: false}).inputMode, 'controller');
});

test('touch AR requires the supplied DOM overlay for placement, playback and exit controls', () => {
  const overlayRoot = Object.freeze({id: 'xr-touch-overlay'});
  const options = xrSessionOptions({mode: 'live', vrSupported: false, overlayRoot});
  assert.equal(options.type, 'immersive-ar');
  assert.deepEqual(options.init.requiredFeatures, ['dom-overlay']);
  assert.equal(options.init.domOverlay.root, overlayRoot);
  assert.ok(!options.init.optionalFeatures.includes('dom-overlay'));
});

test('touch AR requests optional geometry even when starting with distance placement', () => {
  // Features cannot be added to a running session when the user switches to auto.
  for (const placementMode of ['auto', 'distance', 'manual']) {
    const {init} = xrSessionOptions({mode: 'live', vrSupported: false, placementMode});
    assert.ok(init.optionalFeatures.includes('local-floor'));
    assert.ok(init.optionalFeatures.includes('hit-test'));
    assert.ok(init.optionalFeatures.includes('plane-detection'));
    assert.ok(!init.requiredFeatures.includes('hit-test'));
    assert.ok(!init.requiredFeatures.includes('plane-detection'));
  }
});

test('controller AR preserves HMD options and does not require DOM overlay', () => {
  const {type, init} = xrSessionOptions({mode: 'live', vrSupported: true, overlayRoot: {}});
  assert.equal(type, 'immersive-ar');
  assert.deepEqual(init.optionalFeatures, ['local-floor', 'plane-detection', 'hit-test']);
  assert.equal(init.requiredFeatures, undefined);
  assert.equal(init.domOverlay, undefined);
  for (const placementMode of ['manual', 'distance']) {
    assert.deepEqual(xrSessionOptions({mode: 'live', vrSupported: true, placementMode}).init,
      {optionalFeatures: ['local-floor']});
  }
});

test('HMD recording prefers immersive VR and keeps body and hand tracking optional', () => {
  const options = xrSessionOptions({mode: 'record', vrSupported: true, preference: 'touch', overlayRoot: {}});
  assert.equal(options.type, 'immersive-vr');
  assert.equal(options.inputMode, 'controller');
  assert.deepEqual(options.init, {optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking']});
});

test('recording falls back to immersive AR without enabling touch live controls', () => {
  const options = xrSessionOptions({mode: 'record', vrSupported: false, preference: 'touch', placementMode: 'auto', overlayRoot: {}});
  assert.equal(options.type, 'immersive-ar');
  assert.equal(options.inputMode, 'controller');
  assert.deepEqual(options.init, {optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking']});
});

test('new session options do not inherit mutations or DOM roots from a prior session', () => {
  const oldRoot = {}, nextRoot = {};
  const oldOptions = xrSessionOptions({mode: 'live', vrSupported: false, overlayRoot: oldRoot});
  oldOptions.init.optionalFeatures.length = 0;
  oldOptions.init.requiredFeatures.push('unrelated-feature');
  const nextOptions = xrSessionOptions({mode: 'live', vrSupported: false, overlayRoot: nextRoot});
  assert.equal(nextOptions.init.domOverlay.root, nextRoot);
  assert.ok(nextOptions.init.optionalFeatures.includes('hit-test'));
  assert.deepEqual(nextOptions.init.requiredFeatures, ['dom-overlay']);
  assert.equal(xrSessionOptions({mode: 'record', vrSupported: true}).init.domOverlay, undefined);
});
