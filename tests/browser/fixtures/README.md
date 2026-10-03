# Optional local browser fixture

The smoke page uses the public MediaPipe `pose.jpg` test image locally. The
image is intentionally ignored by Git and is not shipped in the application.
Fetch it before opening `/tests/browser/camera-smoke.html` on the Vite dev server:

```sh
curl --fail --location https://storage.googleapis.com/mediapipe-assets/pose.jpg -o tests/browser/fixtures/pose.jpg
```

Official test declaration:
https://github.com/google-ai-edge/mediapipe/blob/master/mediapipe/tasks/testdata/vision/BUILD

The page supplies an image-backed canvas stream instead of accessing a camera.
It loads the real local MediaPipe model and WASM, estimates 33 pose landmarks,
converts them with CameraPoseSampler, captures with MotionRecorder, validates
a JSON round trip, and provides a download. Capture stops after two seconds of
valid motion (ten seconds maximum recorded time). This checks runtime assets
and processing; it does not validate a phone's camera permissions, performance,
or pose accuracy for a moving person.
