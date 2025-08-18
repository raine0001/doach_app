// sessionSummary.js

let sessionData = {
  shotCount: 0,
  madeCount: 0,
  releaseAngles: [],
  releaseHeights: [],
  entryAngles: [],
  kneeBends: [],
  elbowPositions: [],
  shoulderAngles: [],
  wristFollowThroughs: [],
  apexHeights: [],
  ballSpeeds: [],
  releaseTimes: [],
  coreStabilities: [],
  feedbackLogs: [],
  startTime: null,
  endTime: null,
  surfaceType: 'hardwood',
  indoorOutdoor: 'indoor',
  userNotes: ''
};

// 📌 Call at session start
export function startSession() {
  sessionData.startTime = new Date();
  sessionData.shotCount = 0;
  sessionData.madeCount = 0;
  sessionData.releaseAngles = [];
  sessionData.releaseHeights = [];
  sessionData.entryAngles = [];
  sessionData.kneeBends = [];
  sessionData.elbowPositions = [];
  sessionData.shoulderAngles = [];
  sessionData.wristFollowThroughs = [];
  sessionData.apexHeights = [];
  sessionData.ballSpeeds = [];
  sessionData.releaseTimes = [];
  sessionData.coreStabilities = [];
  sessionData.feedbackLogs = [];
  sessionData.userNotes = '';
}

// 📌 Call per shot
export function logShot({
  made,
  releaseAngle,
  releaseHeight,
  entryAngle,
  kneeBend,
  elbowPosition,
  shoulderAngle,
  wristFollowThrough,
  apexHeight,
  ballSpeed,
  releaseTime,
  coreStability,
  coachFeedbackGiven,
  userMarkedFeedbackHelpful,
  userCorrectedModel
}) {
  sessionData.shotCount += 1;
  if (made) sessionData.madeCount += 1;
  if (releaseAngle) sessionData.releaseAngles.push(releaseAngle);
  if (releaseHeight) sessionData.releaseHeights.push(releaseHeight);
  if (entryAngle) sessionData.entryAngles.push(entryAngle);
  if (kneeBend) sessionData.kneeBends.push(kneeBend);
  if (elbowPosition) sessionData.elbowPositions.push(elbowPosition);
  if (shoulderAngle) sessionData.shoulderAngles.push(shoulderAngle);
  if (wristFollowThrough !== undefined) sessionData.wristFollowThroughs.push(wristFollowThrough);
  if (apexHeight) sessionData.apexHeights.push(apexHeight);
  if (ballSpeed) sessionData.ballSpeeds.push(ballSpeed);
  if (releaseTime) sessionData.releaseTimes.push(releaseTime);
  if (coreStability) sessionData.coreStabilities.push(coreStability);
  sessionData.feedbackLogs.push({
    coachFeedbackGiven,
    userMarkedFeedbackHelpful,
    userCorrectedModel
  });
}

// 📌 Call at session end
export function endSession(userNotes = '') {
  sessionData.endTime = new Date();
  sessionData.userNotes = userNotes;
}

// 📦 Get final summary
export function getSessionSummary() {
  const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;

  return {
    made_percentage: (sessionData.shotCount ? (sessionData.madeCount / sessionData.shotCount) : 0).toFixed(2),
    avg_release_angle: avg(sessionData.releaseAngles),
    avg_release_height: avg(sessionData.releaseHeights),
    avg_entry_angle: avg(sessionData.entryAngles),
    avg_knee_bend: avg(sessionData.kneeBends),
    avg_elbow_position: avg(sessionData.elbowPositions),
    avg_shoulder_angle: avg(sessionData.shoulderAngles),
    avg_wrist_follow_through: avg(sessionData.wristFollowThroughs),
    avg_apex_height: avg(sessionData.apexHeights),
    avg_ball_speed: avg(sessionData.ballSpeeds),
    avg_release_time: avg(sessionData.releaseTimes),
    core_stability_score: avg(sessionData.coreStabilities),
    coach_feedback_given: sessionData.feedbackLogs.some(f => f.coachFeedbackGiven),
    user_marked_feedback_helpful: sessionData.feedbackLogs.some(f => f.userMarkedFeedbackHelpful),
    user_corrected_model: sessionData.feedbackLogs.some(f => f.userCorrectedModel),
    user_notes: sessionData.userNotes,
    shot_count: sessionData.shotCount,
    made_count: sessionData.madeCount,
    duration_seconds: sessionData.endTime && sessionData.startTime
      ? Math.round((sessionData.endTime - sessionData.startTime) / 1000)
      : 0,
    surface_type: sessionData.surfaceType,
    indoor_outdoor: sessionData.indoorOutdoor
  };
}
