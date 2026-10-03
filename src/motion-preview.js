import * as THREE from 'three';

/** A separate, unclipped space for checking motion outside the portal. */
export function createMotionPreview(scene, stage) {
  const room = new THREE.Group();
  room.visible = false; scene.add(room);
  const grid = new THREE.GridHelper(4, 16, 0x748856, 0x343b47);
  grid.position.y = -.015; room.add(grid);
  let model = null;
  return {
    room,
    show(vrm, enabled) {
      const next = vrm?.scene;
      const parent = enabled ? room : stage;
      room.visible = enabled;
      if (!next) return;
      if (next !== model || next.parent !== parent) {
        parent.add(next);
        next.position.z = enabled ? 0 : -1.1;
        next.traverse(object => {
          if (!object.isMesh) return;
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.stencilWrite = !enabled;
        });
        model = next;
      }
    },
    place(camera, hasFloor) {
      const position = camera.getWorldPosition(new THREE.Vector3());
      const forward = camera.getWorldDirection(new THREE.Vector3());forward.y = 0;
      if (forward.lengthSq() < .001) forward.set(0, 0, -1);
      forward.normalize();
      room.position.copy(position).addScaledVector(forward, 2.2);
      room.position.y = hasFloor ? 0 : position.y - 1.65;
      room.rotation.set(0, Math.atan2(-forward.x, -forward.z), 0);
    },
    reset() {room.position.set(0, 0, 0); room.quaternion.identity();},
  };
}
