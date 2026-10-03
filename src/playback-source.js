import { applyCaptureToVRM } from './motion-data.js';
import { applyDemoMotion } from './demo-motion.js';

/** Keep the selected recording when entering AR; LAN reception takes priority. */
export function resolvePlaybackSource(choice, take, { watchingLAN = false } = {}) {
  return watchingLAN ? 'live' : choice === 'take' && take ? 'take' : 'demo';
}

/** The same take can play in the page or a placed, tracked AR stage. */
export function canResumeTake({ source, take, sessionMode = null, xrBusy = false,
  cameraOpen = false, inputReady = false, placed = false, tracking = false,
  visibility = 'visible' } = {}) {
  if (source !== 'take' || !take || xrBusy || cameraOpen) return false;
  return sessionMode === null || (sessionMode === 'live' && inputReady && placed && tracking && visibility === 'visible');
}

/**
 * isCurrent must check both the caller's request token and its current mode.
 * In particular, ending AR may make desktop playback valid while invalidating
 * the pending AR start. Do not start its music or clock after that transition.
 */
export async function startTakePlayback({ audio, withMusic = false, offset = 0, isCurrent, onStart }) {
  if (!isCurrent()) return false;
  if (withMusic) {
    await audio.prepare();
    if (!isCurrent()) return false;
    audio.play(offset);
  }
  onStart();
  return true;
}

/** Apply exactly the selected source in either desktop or AR coordinates. */
export function applyPlaybackMotion(vrm, { source, take, t = 0, takePlayer, demoPlayer, restHips } = {}) {
  if (!vrm) return false;
  const time = Math.max(0, Number.isFinite(t) ? t : 0);
  if (source === 'take' && take) {
    if (take.format === 'vrma') {
      if (!takePlayer) return false;
      takePlayer.seek(time);
    } else if (take.format === 'vli.motion-capture') {
      return applyCaptureToVRM(vrm, take, time);
    } else if (take.format === 'vli.demo-motion') {
      applyDemoMotion(vrm, take, time, restHips);
    } else return false;
    return true;
  }
  if (source === 'demo' && demoPlayer) { demoPlayer.seek(time); return true; }
  return false;
}
