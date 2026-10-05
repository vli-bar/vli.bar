export function isAppleMobile({userAgent = '', platform = '', maxTouchPoints = 0} = {}) {
  return /iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
}

export function liveDeviceType({preference = 'auto', vrSupported = false, navigator: device = {}} = {}) {
  if (preference !== 'auto') return preference;
  return vrSupported ? 'headset' : /Android/i.test(device.userAgent ?? '') || isAppleMobile(device) ? 'phone' : 'desktop';
}

export function arViewMode({arSupported = false, vrSupported = false, cameraAvailable = false} = {}) {
  return arSupported ? 'webxr' : vrSupported ? 'vr' : cameraAvailable ? 'marker' : null;
}
