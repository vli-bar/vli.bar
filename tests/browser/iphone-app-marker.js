// Test-build-only adapter. Only the camera acquisition is replaced; the actual
// app, ArUco detector, pose solver, VRM, playback and LAN code remain unchanged.
import {MarkerAR as CameraMarkerAR} from '../../src/marker-ar.js';

export class MarkerAR extends CameraMarkerAR {
  constructor(options) {
    const source = document.createElement('canvas');source.width = 640;source.height = 480;
    const context = source.getContext('2d'), marker = new Image();marker.src = '/markers/stage.svg';
    const state = {visible:true, timer:null, stream:null};
    const panel = document.createElement('aside');panel.id = 'synthetic-camera-controls';
    panel.style.cssText = 'position:fixed;right:0;top:80px;z-index:1200;background:#243245;padding:8px;max-width:190px;font-size:10px';
    const result = document.createElement('pre');result.id = 'synthetic-camera-state';result.style.cssText = 'white-space:pre-wrap;max-height:100px;overflow:auto';
    const draw = () => {
      context.fillStyle = '#c3c6cb';context.fillRect(0,0,source.width,source.height);
      if (state.visible) {context.imageSmoothingEnabled = false;context.drawImage(marker,source.width/2-25,source.height/2-25,50,50);}
      context.fillStyle = '#121622';context.font = '12px monospace';context.fillText(`SYNTHETIC CAMERA ${Math.round(performance.now())}`,4,18);
    };
    for (const [label,action] of [['Hide synthetic marker',()=>{state.visible=false;}],['Show synthetic marker',()=>{state.visible=true;}],
      ['Portrait synthetic camera',()=>{source.width=360;source.height=640;}],['Landscape synthetic camera',()=>{source.width=640;source.height=480;}]]) {
      const button = document.createElement('button');button.textContent=label;button.style.cssText='display:block;padding:8px;margin:4px;font-size:10px';
      button.onclick=()=>{action();draw();};panel.append(button);
    }
    panel.append(result);document.body.append(panel);
    super({...options,deps:{...options.deps,mediaDevices:{async getUserMedia() {
      await marker.decode();draw();state.timer=setInterval(draw,50);state.stream=source.captureStream(20);return state.stream;
    }}}});
    this.fixture = {state,result};
  }
  update(time) {
    const tracked = super.update(time);
    this.fixture.result.textContent = JSON.stringify({tracked,ready:this.ready,frame:[this.width,this.height],
      tracks:this.fixture.state.stream?.getTracks().map(t=>t.readyState)},null,2);
    return tracked;
  }
  stop(options) {
    const stopped = super.stop(options);
    if (this.fixture) {
      clearInterval(this.fixture.state.timer);
      this.fixture.result.textContent = JSON.stringify({tracked:this.tracked,ready:this.ready,tracks:this.fixture.state.stream?.getTracks().map(t=>t.readyState)},null,2);
    }
    return stopped;
  }
}
