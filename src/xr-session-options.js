/** Prefer actual immersive capabilities; PICO also reports an Android UA. */
export function xrInputMode(preference, vrSupported) {
  return ['touch', 'controller'].includes(preference) ? preference : vrSupported ? 'controller' : 'touch';
}

export function xrSessionOptions({mode, arSupported = false, vrSupported = false, sessionPreference = 'auto', preference = 'auto', placementMode = 'auto', overlayRoot}) {
  if (!arSupported && !vrSupported) return null;
  if (mode === 'record') return {
    type: vrSupported ? 'immersive-vr' : 'immersive-ar', inputMode: 'controller',
    init: {optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking']},
  };
  const type = sessionPreference === 'vr' ? (vrSupported ? 'immersive-vr' : null)
    : arSupported ? 'immersive-ar' : 'immersive-vr';
  if (!type) return null;
  // VR has no DOM overlay requirement, even if a phone preference was saved.
  const inputMode = type === 'immersive-vr' ? 'controller' : xrInputMode(preference, vrSupported);
  const geometry = type === 'immersive-ar' && (inputMode === 'touch' || placementMode === 'auto');
  const optionalFeatures = geometry ? ['local-floor', 'plane-detection', 'hit-test', 'depth-sensing'] : ['local-floor'];
  if (inputMode === 'controller') optionalFeatures.push('hand-tracking');
  // Touch AR needs visible controls throughout the session, including exit.
  // A browser without DOM overlay must decline instead of trapping the user.
  const init = inputMode === 'touch'
    ? {requiredFeatures: ['dom-overlay'], optionalFeatures, domOverlay: {root: overlayRoot}}
    : {optionalFeatures};
  // Optional depth still needs preferences. CPU access lets us fit a wall
  // locally; devices without depth retain plane detection and hit testing.
  if (geometry) init.depthSensing = {
    usagePreference: ['cpu-optimized'], dataFormatPreference: ['float32', 'luminance-alpha'], matchDepthView: true,
  };
  return {type, inputMode, init};
}
