import * as THREE from 'three';

export function buildStage(scene) {
const stage = new THREE.Group(); scene.add(stage);
scene.add(new THREE.HemisphereLight(0xc6d8ff,0x393349,3));
const light = new THREE.DirectionalLight(0xffe5ee,3); light.position.set(1,3,3); scene.add(light);
const pink = new THREE.PointLight(0xff3aba,15,8); pink.position.set(-1,2,-1); stage.add(pink);
const cyan = new THREE.PointLight(0x42d9ff,12,8); cyan.position.set(1,2,-2); stage.add(cyan);
// Write the opening to the stencil buffer. All interior geometry is clipped to it.
const maskMat = new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,depthTest:false,side:THREE.DoubleSide,stencilWrite:true,stencilRef:1,stencilFunc:THREE.AlwaysStencilFunc,stencilZPass:THREE.ReplaceStencilOp});
const mask = new THREE.Mesh(new THREE.PlaneGeometry(2.4,2.5),maskMat);
mask.position.set(0,1.25,0); mask.renderOrder=1; stage.add(mask);
function stencil(mat){mat.stencilWrite=true;mat.stencilRef=1;mat.stencilFunc=THREE.EqualStencilFunc;mat.stencilFail=THREE.KeepStencilOp;mat.stencilZFail=THREE.KeepStencilOp;mat.stencilZPass=THREE.KeepStencilOp;}
function box(w,h,d,x,y,z,color,emissive=false,clipped=true){
 const mat=new THREE.MeshStandardMaterial({color,roughness:.6,emissive:emissive?color:0,emissiveIntensity:emissive?2:0}); if(clipped)stencil(mat);
 const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.renderOrder=clipped?2:4;stage.add(m);return m;
}
box(5,.12,4,0,-.07,-2,0x242339);box(5,3,.1,0,1.4,-3.5,0x19162f);
box(.1,3,4,-2.4,1.4,-2,0x24203c);box(.1,3,4,2.4,1.4,-2,0x24203c);
for(let i=0;i<5;i++){const z=-.6-i*.65;box(2.2,.035,.025,0,.02,z,0x956bff,true);box(.025,2.4,.025,-1.08,1.2,z,0x6046c6,true);box(.025,2.4,.025,1.08,1.2,z,0x6046c6,true);box(2.2,.025,.025,0,2.4,z,0x6046c6,true);}
box(.045,2.56,.07,-1.23,1.25,.01,0xc6ff75,true,false);box(.045,2.56,.07,1.23,1.25,.01,0xc6ff75,true,false);box(2.5,.045,.07,0,2.52,.01,0xc6ff75,true,false);
const curtain = box(2.4,2.5,.025,0,1.25,.035,0x582254,false,false);
curtain.visible=false;
// Pleats remain part of the curtain as it descends and rises.
for(let i=0;i<24;i++){const pleat=new THREE.Mesh(new THREE.BoxGeometry(.04,2.5,.035),new THREE.MeshStandardMaterial({color:i%2?0x762e68:0x401d48}));pleat.position.set(-1.15+i*.1,0,.02);pleat.renderOrder=5;curtain.add(pleat);}

return {stage, curtain, stencil};
}
