import * as THREE from 'three';

const FORWARD = new THREE.Vector3(0, 0, -1);
const RAY_LENGTH = 2;
const PANEL_WIDTH = 1;
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
 * Head-locked instructions and action buttons work without DOM overlay.
 * Wire selectstart/select/selectend to beginSelect/selectAction/endSelect and
 * resetInputs on visibility loss, recentering, and session end. Vision Pro's
 * transient pointer reveals the intended gaze target only at gesture start;
 * retain the resolved button, never a native XRFrame or a persistent gaze ray.
 * The optional canvas dependency keeps the geometry testable without a browser.
 */
export function createXRHUD(scene, { canvas = document.createElement('canvas') } = {}) {
  canvas.width = 1280; canvas.height = 384;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('XR HUD requires a 2D canvas context');
  let texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH, .30), material);
  panel.name = 'xr-hud';
  panel.renderOrder = 99; panel.visible = false; scene.add(panel);
  const targetMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthTest: false, depthWrite: false });
  const buttons = [];
  const gestures = new Map();
  const pointers = new THREE.Group();
  pointers.name = 'xr-hud-pointers'; pointers.visible = false; scene.add(pointers);
  const rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), FORWARD]);
  const pointerViews = new Map();
  const raycaster = new THREE.Raycaster();
  raycaster.near = 0; raycaster.far = RAY_LENGTH;
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), matrix = new THREE.Matrix4();
  let previous = '', hovered = null, title = '', subtitle = '', recording = false, exitLabel = 'ページへ戻る';
  let actions = [], actionsKey = '', layoutKey = '';

  function buttonSignature(button) { return JSON.stringify([button.id, button.label, button.enabled]); }

  function layout() {
    const all = [...actions, { id: 'exit', label: `← ${exitLabel}`, enabled: true }];
    for (const gesture of gestures.values()) {
      if (gesture.id && !all.some(button => button.id === gesture.id && buttonSignature(button) === gesture.signature)) gesture.valid = false;
    }
    const nextLayout = all.map(button => button.id).join('|');
    if (layoutKey !== nextLayout) {
      layoutKey = nextLayout;
      for (const button of buttons) { panel.remove(button.target); button.target.geometry.dispose(); }
      buttons.length = 0;
      const nextHeight = all.length === 1 ? 384 : 210 + Math.ceil(all.length / 2) * 120 + 54;
      if (canvas.height !== nextHeight) {
        canvas.height = nextHeight;
        // WebGL textures cannot change dimensions after upload. Replace the
        // texture when the action grid changes its number of rows.
        texture.dispose(); texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace; material.map = texture; material.needsUpdate = true;
      }
      panel.geometry.dispose();
      const height = canvas.height / canvas.width * PANEL_WIDTH;
      panel.geometry = new THREE.PlaneGeometry(PANEL_WIDTH, height);
      for (let index = 0; index < all.length; index++) {
        const bounds = all.length === 1 ? BUTTON : { x: 48 + (index % 2) * 604, y: 210 + Math.floor(index / 2) * 120, width: 580, height: 96 };
        const target = new THREE.Mesh(new THREE.PlaneGeometry(bounds.width / canvas.width * PANEL_WIDTH, bounds.height / canvas.height * height), targetMaterial);
        target.name = `xr-hud-${all[index].id}-target`;
        target.position.set(((bounds.x + bounds.width / 2) / canvas.width - .5) * PANEL_WIDTH, (.5 - (bounds.y + bounds.height / 2) / canvas.height) * height, .002);
        panel.add(target);
        buttons.push({ ...all[index], bounds, target });
      }
      previous = '';
    } else {
      all.forEach((button, index) => Object.assign(buttons[index], button));
    }
  }

  function setActions(next = []) {
    const seen = new Set(['exit', 'blocked']);
    const normalized = [];
    for (const action of Array.isArray(next) ? next : []) {
      if (!action || typeof action.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(action.id) || seen.has(action.id)) continue;
      seen.add(action.id);
      normalized.push({ id: action.id, label: String(action.label ?? action.id), enabled: action.enabled !== false });
      if (normalized.length === 5) break;
    }
    const key = JSON.stringify(normalized);
    if (key === actionsKey) return;
    actionsKey = key; actions = normalized;
    layout();
    if (panel.visible) paint();
  }

  function paint() {
    const next = JSON.stringify([title, subtitle, recording, exitLabel, hovered, actionsKey]);
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
    for (const button of buttons) {
      const over = hovered === button.id && button.enabled;
      const { x, y, width, height } = button.bounds;
      ctx.fillStyle = !button.enabled ? '#34404c' : over ? '#f2ffe2' : '#c6ff75';
      roundedRect(ctx, x, y, width, height, 18); ctx.fill();
      ctx.lineWidth = over ? 5 : 2;
      ctx.strokeStyle = !button.enabled ? '#566272' : over ? '#ffffff' : '#d5ff9d'; ctx.stroke();
      ctx.fillStyle = button.enabled ? '#172011' : '#b5bdc8'; ctx.font = 'bold 34px sans-serif';
      ctx.fillText(button.label, x + width / 2, y + height / 2 + 13, width - 40);
    }
    ctx.fillStyle = '#bdc5d2'; ctx.font = '20px sans-serif';
    ctx.fillText('ボタンを選んでピンチ / トリガー', 640, canvas.height - 19, 1180);
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
    if (!['tracked-pointer', 'transient-pointer', 'gaze', 'screen'].includes(inputSource.targetRayMode)) return false;
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
    const intersection = raycaster.intersectObjects(buttons.map(button => button.target), false)[0];
    return intersection ? { ...intersection, button: buttons.find(button => button.target === intersection.object) } : null;
  }

  function hidePointers() {
    pointers.visible = false;
    for (const line of pointerViews.values()) line.visible = false;
    setHover(null);
  }

  function resetInputs() {
    gestures.clear(); hidePointers();
    for (const line of pointerViews.values()) { pointers.remove(line); line.material.dispose(); }
    pointerViews.clear();
  }

  function selectAction(frame, inputSource, referenceSpace) {
    if (inputSource?.targetRayMode === 'transient-pointer') {
      const gesture = gestures.get(inputSource);
      gestures.delete(inputSource);
      if (!panel.visible || !frame || !gesture || gesture.session !== frame.session || gesture.referenceSpace !== referenceSpace
        || (frame?.session?.visibilityState && frame.session.visibilityState !== 'visible')) return 'blocked';
      if (!gesture.valid) return 'blocked';
      if (!gesture.id) return null;
      const button = buttons.find(button => button.id === gesture.id);
      return button?.enabled && buttonSignature(button) === gesture.signature ? button.id : 'blocked';
    }
    if (!panel.visible || !inputRay(frame, inputSource, referenceSpace)) return null;
    const intersection = hit();
    return intersection ? intersection.button.enabled ? intersection.button.id : 'blocked' : null;
  }

  layout();

  return {
    follow,
    setActions,
    resetInputs,
    beginSelect(frame, inputSource, referenceSpace) {
      if (inputSource?.targetRayMode !== 'transient-pointer') return;
      const valid = panel.visible && inputRay(frame, inputSource, referenceSpace);
      const button = valid ? hit()?.button : null;
      gestures.set(inputSource, { session: frame?.session, referenceSpace, valid, id: button?.id ?? null, signature: button ? buttonSignature(button) : null });
      setHover(button?.id ?? null);
    },
    endSelect(inputSource) { gestures.delete(inputSource); },
    selectAction,
    update(camera, nextTitle, nextSubtitle, active, nextRecording = false, nextExitLabel = nextRecording ? '保存して戻る' : 'ページへ戻る') {
      panel.visible = active;
      if (!active) { resetInputs(); return; }
      title = nextTitle; subtitle = nextSubtitle; recording = nextRecording; exitLabel = nextExitLabel;
      layout(); follow(camera); paint();
    },
    /** Refresh hover and visible controller rays from this XR frame's poses. */
    updatePointers(frame, inputSources, referenceSpace) {
      if (!panel.visible || (frame?.session?.visibilityState && frame.session.visibilityState !== 'visible')) { resetInputs(); return false; }
      const current = new Set(inputSources ?? []);
      for (const source of gestures.keys()) if (!current.has(source)) gestures.delete(source);
      for (const [source, line] of pointerViews) {
        if (!current.has(source)) {
          pointers.remove(line); line.material.dispose(); pointerViews.delete(source);
        }
      }
      pointers.visible = true;
      let overButton = null;
      for (const source of current) {
        let line = pointerViews.get(source);
        if (line) line.visible = false;
        if (!inputRay(frame, source, referenceSpace)) continue;
        const intersection = hit();
        if (intersection?.button.enabled) overButton = intersection.button.id;
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
        line.material.color.setHex(intersection?.button.enabled ? 0xc6ff75 : 0xa1b7c7);
        line.material.opacity = intersection?.button.enabled ? 1 : .6;
      }
      setHover(overButton);
      return !!overButton;
    },
    /** True consumes this select: save/end XR and return before stage actions. */
    select(frame, inputSource, referenceSpace) {
      return selectAction(frame, inputSource, referenceSpace) === 'exit';
    },
    dispose() {
      panel.visible = false; resetInputs(); scene.remove(panel); scene.remove(pointers);
      panel.geometry.dispose(); material.dispose(); texture.dispose();
      for (const button of buttons) button.target.geometry.dispose();
      targetMaterial.dispose(); rayGeometry.dispose();
      for (const line of pointerViews.values()) line.material.dispose();
      pointerViews.clear();
    },
  };
}
