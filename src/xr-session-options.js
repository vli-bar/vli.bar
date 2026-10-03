/** Prefer actual immersive capabilities; PICO also reports an Android UA. */
export function xrInputMode(preference, vrSupported) {
  return ['touch', 'controller'].includes(preference) ? preference : vrSupported ? 'controller' : 'touch';
}

export function xrSessionOptions({mode, vrSupported, preference = 'auto', placementMode = 'auto', overlayRoot}) {
  if (mode === 'record') return {
    type: vrSupported ? 'immersive-vr' : 'immersive-ar', inputMode: 'controller',
    init: {optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking']},
  };
  const inputMode = xrInputMode(preference, vrSupported);
  const optionalFeatures = inputMode === 'touch' || placementMode === 'auto' ? ['local-floor', 'plane-detection', 'hit-test'] : ['local-floor'];
  // Touch AR needs visible controls throughout the session, including exit.
  // A browser without DOM overlay must decline instead of trapping the user.
  const init = inputMode === 'touch'
    ? {requiredFeatures: ['dom-overlay'], optionalFeatures, domOverlay: {root: overlayRoot}}
    : {optionalFeatures};
  return {type: 'immersive-ar', inputMode, init};
}
