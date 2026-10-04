import * as THREE from 'three';

/** Fit the full camera image, preserving exactly the same projection as video. */
export function fitCameraFrame(width, height, availableWidth, availableHeight) {
  if (![width, height, availableWidth, availableHeight].every(n => Number.isFinite(n) && n > 0)) return null;
  const scale = Math.min(availableWidth / width, availableHeight / height);
  return {width: width * scale, height: height * scale};
}

/** The printed marker center is the center of the portal opening on the wall. */
export function placeMarkerStage(stage, markerPose, width = 2.4) {
  if (!markerPose?.elements.every(Number.isFinite) || !Number.isFinite(width) || width < 1 || width > 4 ||
      Math.abs(markerPose.determinant() - 1) > .02) return false;
  const scale = width / 2.4;
  const matrix = markerPose.clone().multiply(new THREE.Matrix4().makeTranslation(0, -1.25 * scale, 0))
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  matrix.decompose(stage.position, stage.quaternion, stage.scale);
  stage.updateWorldMatrix(true, false);
  return true;
}

/** Phone camera pose in the shared stage frame. No face image or hand poses. */
export function markerAudiencePose(camera, stage, tracked) {
  const hidden = {t: 0, visibility: 'hidden', head: null, left: null, right: null, body: null};
  if (!tracked) return hidden;
  camera.updateWorldMatrix(true, false);stage.updateWorldMatrix(true, false);
  if (!stage.matrixWorld.elements.every(Number.isFinite) || stage.matrixWorld.determinant() < 1e-8) return hidden;
  const position = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(stage.matrixWorld.clone().invert());
  const rotation = stage.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(camera.getWorldQuaternion(new THREE.Quaternion())).normalize();
  if (!position.toArray().every(n => Number.isFinite(n) && Math.abs(n) <= 50) || !rotation.toArray().every(Number.isFinite)) return hidden;
  return {...hidden, visibility: 'visible', head: {position: position.toArray(), quaternion: rotation.toArray(), emulatedPosition: false, source: 'viewer'}};
}
