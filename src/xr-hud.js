import * as THREE from 'three';

/** Head-locked instructions remain usable when DOM overlay is unavailable. */
export function createXRHUD(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false});
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(.85,.16), material);
  panel.renderOrder = 99; panel.visible = false; scene.add(panel);
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  let previous='';
  function follow(camera) {
    camera.getWorldPosition(position); camera.getWorldQuaternion(rotation);
    panel.position.set(0,-.36,-1.1).applyQuaternion(rotation).add(position);
    panel.quaternion.copy(rotation);
  }
  return {
    follow,
    update(camera, title, subtitle, active, recording=false) {
      panel.visible=active;
      if (!active) return;
      follow(camera);
      const next=`${title}|${subtitle}|${recording}`;
      if (next===previous) return;
      previous=next;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle='rgba(13,17,24,.90)';ctx.fillRect(0,0,1024,192);
      ctx.fillStyle=recording?'#ff7d96':'#c6ff75';ctx.fillRect(0,0,6,192);
      ctx.textAlign='center';ctx.fillStyle=recording?'#ff7d96':'#c6ff75';
      ctx.font='bold 40px sans-serif';ctx.fillText(title,512,78,960);
      ctx.fillStyle='#e6e8ef';ctx.font='26px sans-serif';ctx.fillText(subtitle,512,135,960);
      texture.needsUpdate=true;
    },
  };
}
