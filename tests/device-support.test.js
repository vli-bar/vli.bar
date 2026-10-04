import test from 'node:test';
import assert from 'node:assert/strict';
import {isAppleMobile, liveDeviceType, arViewMode} from '../src/device-support.js';

test('iPhone and iPad including desktop Safari identify as phones for face-only presence', () => {
  for (const navigator of [{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'},
    {userAgent:'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'},{userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5}]) {
    assert.equal(isAppleMobile(navigator),true);
    assert.equal(liveDeviceType({navigator}),'phone');
  }
  assert.equal(isAppleMobile({platform:'MacIntel',maxTouchPoints:0}),false);
  assert.equal(liveDeviceType({navigator:{userAgent:'Android'}}),'phone');
  assert.equal(liveDeviceType({navigator:{userAgent:'Android'},vrSupported:true}),'headset');
  assert.equal(liveDeviceType({preference:'desktop',navigator:{userAgent:'iPhone'}}),'desktop');
});

test('AR routes by actual capabilities with camera marker fallback', () => {
  assert.equal(arViewMode({arSupported:true,cameraAvailable:true}),'webxr');
  assert.equal(arViewMode({arSupported:true,cameraAvailable:false}),'webxr');
  assert.equal(arViewMode({cameraAvailable:true}),'marker');
  assert.equal(arViewMode(),null);
});
