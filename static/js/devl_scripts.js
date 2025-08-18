// ✅ Full Updated Function Summary (Aug 3)
// Keeps functions organized by purpose and dependencies for debugging & refactoring

const functionDirectory = [
  {
    name: 'initPoseDetector()',
    purpose: 'Loads MediaPipe Pose detector, sets options, initializes debug box',
    dependsOn: ['PoseLandmarker', 'updateDebugOverlay()']
  },
  {
    name: 'updateDebugOverlay()',
    purpose: 'Renders pose/ball status into floating debug div on screen',
    dependsOn: ['fix_overlay_display.js']
  },
  {
    name: 'syncOverlayToVideo()',
    purpose: 'Resizes video + overlay canvas to native resolution of uploaded clip',
    dependsOn: ['fix_overlay_display.js']
  },
  {
    name: 'handleVideoUpload()',
    purpose: 'Uploads video, resets trackers, and uses manual frame stepping to process playback with overlay drawing',
    dependsOn: ['fetch()', 'resetTracking()', 'resetShotStats()', 'resetPlayerTracker()', 'drawLiveOverlay()', 'analyzeVideoFrameByFrame()']
  },
  {
    name: 'startTracking()',
    purpose: 'Begins pose + object tracking loop, manages frame buffers, release, shot flow',
    dependsOn: ['sendFrameToDetect()', 'trackFrame()', 'processShotFrames()', 'startCanvasRecording()']
  },
  {
    name: 'trackFrame()',
    purpose: 'Inner loop inside startTracking; updates trackers, buffers, poses, and calls updateBall()',
    dependsOn: ['poseDetector.detectForVideo()', 'updatePlayerTracker()', 'updateBall()', 'trailShouldStart()', 'updateDebugOverlay()', 'emergencyDebugDump()']
  },
  {
    name: 'sendFrameToDetect()',
    purpose: 'Takes frame canvas, sends to YOLO/pose backend, updates window.lastDetectedFrame',
    dependsOn: ['fetch()', '/detect_frame', 'poseDetector', 'canvas.toDataURL()']
  },
  {
    name: 'processShotFrames()',
    purpose: 'Processes buffered + post-release frames after shot ends, sends them to backend',
    dependsOn: ['sendFrameToDetect()', 'stopCanvasRecording()', 'bufferedFrames', 'postReleaseQueue']
  },
  {
    name: 'startBackgroundProcessing()',
    purpose: 'Starts interval loop to send idle frames for detection in background',
    dependsOn: ['setInterval()', 'sendFrameToDetect()', 'backgroundQueue']
  },
  {
    name: 'animateOverlayLoop()',
    purpose: 'Main canvas loop; draws trail, stats, checks rimCross, freezes, logs shot',
    dependsOn: ['drawLiveOverlay()', 'getHoopCenter()', 'detectAndLogShot()', 'freezeTrail()']
  },
  {
    name: 'emergencyDebugDump()',
    purpose: 'Logs full debug dump of frame index, ball presence, pose, trail length, and state',
    dependsOn: ['ballState', 'playerState', 'window.lastDetectedFrame']
  },
  {
    name: 'analyzeVideoFrameByFrame()',
    purpose: 'Manually processes video frame-by-frame, stores detection output (trail, pose) for fast overlay playback',
    dependsOn: ['canvas.drawImage()', 'sendFrameToDetect()', 'frameArchive.push()', 'overlayCallback()']
  },
  {
    name: 'playArchivedOverlay()',
    purpose: 'Plays video at normal speed while rendering previously archived overlay frames from frameArchive[]',
    dependsOn: ['videoPlayer.currentTime', 'requestAnimationFrame()', 'drawOverlayFromSavedData()']
  },
  {
    name: 'smoothBox()',
    purpose: 'Applies exponential smoothing to bounding boxes to prevent jitter',
    dependsOn: ['prevBox', 'newBox']
  },
  {
    name: 'togglePlay()',
    purpose: 'Play or pause the video element',
    dependsOn: ['videoPlayer']
  },
  {
    name: 'useCamera()',
    purpose: 'Starts webcam and plays video stream into player',
    dependsOn: ['navigator.mediaDevices', 'videoPlayer.srcObject']
  },
  {
    name: 'resetShots()',
    purpose: 'Clears shot state, DOM table, repaints',
    dependsOn: ['resetTracking()', 'resetPlayerTracker()', 'resetShotStats()', 'DOM']
  },
  {
    name: 'trailShouldStart()',
    purpose: 'Returns true if the ball is close to player + rising + above shoulder',
    dependsOn: ['ball', 'playerState.box']
  }
];
