import * as THREE from 'three';

const FORWARD = new THREE.Vector3(0, 0, -1);
const RAY_LENGTH = 2;
const PANEL_WIDTH = 1;
const PANEL_HEIGHT = .30;
const BUTTON = { x: 342, y: 219, width: 596, height: 112 };

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y); ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius); ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Head-locked instructions and a controller-selectable exit work without DOM
 * overlay. Call updatePointers after follow each XR frame. select only returns
 * whether the exit was selected; the caller saves its recording and ends XR.
 * The optional canvas dependency keeps the geometry testable without a browser.
 */
export function createXRHUD(scene, { canvas = document.createElement('canvas') } = {}) {
  canvas.width = 1280; canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('XR HUD requires a 2D canvas context');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT), material);
  panel.name = 'xr-hud';
  panel.renderOrder = 99; panel.visible = false; scene.add(panel);
  // The visible button is painted on the panel. This invisible front-facing
  // target matches its bounds exactly, with a small offset to prevent overlap.
  const exitTarget = new THREE.Mesh(
    new THREE.PlaneGeometry(BUTTON.width / canvas.width * PANEL_WIDTH, BUTTON.height / canvas.height * PANEL_HEIGHT),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthTest: false, depthWrite: false }),
  );
  exitTarget.name = 'xr-hud-exit-target';
  exitTarget.position.set(
    ((BUTTON.x + BUTTON.width / 2) / canvas.width - .5) * PANEL_WIDTH,
    (.5 - (BUTTON.y + BUTTON.height / 2) / canvas.height) * PANEL_HEIGHT,
    .002,
  );
  panel.add(exitTarget);
  const pointers = new THREE.Group();
  pointers.name = 'xr-hud-pointers'; pointers.visible = false; scene.add(pointers);
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), FORWARD]);
  const pointerViews = new Map();
  const raycaster = new THREE.Raycaster();
  raycaster.near = 0; raycaster.far = RAY_LENGTH;
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), matrix = new THREE.Matrix4();
  let previous = '', hovered = false, title = '', subtitle = '', recording = false, exitLabel = 'ページへ戻る';

  function paint() {
    const next = JSON.stringify([title, subtitle, recording, exitLabel, hovered]);
    if (next === previous) return;
    previous = next;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(13,17,24,.94)';
    roundedRect(ctx, 0, 0, canvas.width, canvas.height, 24); ctx.fill();
    ctx.fillStyle = recording ? '#ff7d96' : '#c6ff75'; ctx.fillRect(0, 18, 6, canvas.height - 36);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = recording ? '#ff7d96' : '#c6ff75';
    ctx.font = 'bold 40px sans-serif'; ctx.fillText(title, 640, 77, 1180);
    ctx.fillStyle = '#e6e8ef'; ctx.font = '28px sans-serif'; ctx.fillText(subtitle, 640, 137, 1180);
    ctx.fillStyle = '#36404d'; ctx.fillRect(44, 178, 1192, 1);
    ctx.fillStyle = hovered ? '#f2ffe2' : '#c6ff75';
    roundedRect(ctx, BUTTON.x, BUTTON.y, BUTTON.width, BUTTON.height, 18); ctx.fill();
    ctx.lineWidth = hovered ? 5 : 2;
    ctx.strokeStyle = hovered ? '#ffffff' : '#d5ff9d'; ctx.stroke();
    ctx.fillStyle = '#172011'; ctx.font = 'bold 34px sans-serif';
    ctx.fillText(`← ${exitLabel}`, 640, 288, BUTTON.width - 40);
    ctx.fillStyle = '#bdc5d2'; ctx.font = '20px sans-serif';
    ctx.fillText('ボタンを指してトリガー', 640, 365, 1180);
    texture.needsUpdate = true;
  }

  function setHover(value) {
    if (hovered === value) return;
    hovered = value;
    if (panel.visible) paint();
  }

  function follow(camera) {
    camera.getWorldPosition(position); camera.getWorldQuaternion(rotation);
    panel.position.set(0, -.33, -1.1).applyQuaternion(rotation).add(position);
    panel.quaternion.copy(rotation);
    panel.updateWorldMatrix(true, true);
  }

  function inputRay(frame, inputSource, referenceSpace) {
    if (!frame || !inputSource?.targetRaySpace || !referenceSpace) return false;
    if (frame.session?.visibilityState && frame.session.visibilityState !== 'visible') return false;
    if (!['tracked-pointer', 'gaze', 'screen'].includes(inputSource.targetRayMode)) return false;
    try {
      const pose = frame.getPose(inputSource.targetRaySpace, referenceSpace);
      const transform = pose?.transform?.matrix;
      if (!pose || pose.emulatedPosition || !transform || transform.length !== 16 || !Array.from(transform).every(Number.isFinite)) return false;
      matrix.fromArray(transform);
      raycaster.ray.origin.setFromMatrixPosition(matrix);
      raycaster.ray.direction.copy(FORWARD).transformDirection(matrix);
      return raycaster.ray.direction.lengthSq() > .5;
    } catch {
      // Native XR poses can become unavailable when tracking or the session ends.
      return false;
    }
  }

  function hit() {
    panel.updateWorldMatrix(true, true);
    return raycaster.intersectObject(exitTarget, false)[0] ?? null;
  }

  function hidePointers() {
    pointers.visible = false;
    for (const line of pointerViews.values()) line.visible = false;
    setHover(false);
  }

  return {
    follow,
    update(camera, nextTitle, nextSubtitle, active, nextRecording = false, nextExitLabel = nextRecording ? '保存して戻る' : 'ページへ戻る') {
      panel.visible = active;
      if (!active) { hidePointers(); return; }
      title = nextTitle; subtitle = nextSubtitle; recording = nextRecording; exitLabel = nextExitLabel;
      follow(camera); paint();
    },
    /** Refresh hover and visible controller rays from this XR frame's poses. */
    updatePointers(frame, inputSources, referenceSpace) {
      if (!panel.visible) { hidePointers(); return false; }
      const current = new Set(inputSources ?? []);
      for (const [source, line] of pointerViews) {
        if (!current.has(source)) {
          pointers.remove(line); line.material.dispose(); pointerViews.delete(source);
        }
      }
      pointers.visible = true;
      let overExit = false;
      for (const source of current) {
        let line = pointerViews.get(source);
        if (line) line.visible = false;
        if (!inputRay(frame, source, referenceSpace)) continue;
        const intersection = hit();
        overExit ||= !!intersection;
        if (source.targetRayMode !== 'tracked-pointer') continue;
        if (!line) {
          line = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: 0xa1b7c7, transparent: true, opacity: .8, depthTest: false, depthWrite: false, toneMapped: false }));
          line.name = 'xr-hud-pointer'; line.renderOrder = 100;
          pointers.add(line); pointerViews.set(source, line);
        }
        line.visible = true;
        line.position.copy(raycaster.ray.origin);
        line.quaternion.setFromUnitVectors(FORWARD, raycaster.ray.direction);
        line.scale.set(1, 1, intersection?.distance ?? RAY_LENGTH);
        line.material.color.setHex(intersection ? 0xc6ff75 : 0xa1b7c7);
        line.material.opacity = intersection ? 1 : .6;
      }
      setHover(overExit);
      return overExit;
    },
    /** True consumes this select: save/end XR and return before stage actions. */
    select(frame, inputSource, referenceSpace) {
      return panel.visible && inputRay(frame, inputSource, referenceSpace) && !!hit();
    },
    dispose() {
      scene.remove(panel); scene.remove(pointers);
      panel.geometry.dispose(); material.dispose(); texture.dispose();
      exitTarget.geometry.dispose(); exitTarget.material.dispose(); rayGeometry.dispose();
      for (const line of pointerViews.values()) line.material.dispose();
      pointerViews.clear();
    },
  };
}
