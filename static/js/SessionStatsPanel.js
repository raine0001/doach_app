import React from 'react';
import './SessionStatsPanel.css'; // optional if you want to style it separately

export default function SessionStatsPanel({ summary }) {
  if (!summary) return null;

  const StatRow = ({ label, value }) => (
    <div className="stat-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0' }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span>{value ?? '--'}</span>
    </div>
  );

  return (
    <div style={{
      backgroundColor: '#fff',
      padding: '1rem',
      borderRadius: '12px',
      maxWidth: '400px',
      width: '100%',
      color: '#000',
      margin: '1rem auto',
      boxShadow: '0 2px 6px rgba(0,0,0,0.1)'
    }}>
      <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>📊 Session Summary</h2>

      <StatRow label="Made Percentage" value={(summary.made_percentage * 100).toFixed(0) + '%'} />
      <StatRow label="Average Release Angle" value={`${summary.avg_release_angle}°`} />
      <StatRow label="Average Release Height" value={`${summary.avg_release_height} ft`} />
      <StatRow label="Average Entry Angle" value={`${summary.avg_entry_angle}°`} />

      <StatRow label="Knee Bend" value={`${summary.avg_knee_bend}°`} />
      <StatRow label="Elbow Position" value={`${summary.avg_elbow_position}°`} />
      <StatRow label="Shoulder Angle" value={`${summary.avg_shoulder_angle}°`} />
      <StatRow label="Wrist Follow-through" value={`${(summary.avg_wrist_follow_through * 100).toFixed(0)}%`} />

      <StatRow label="Apex Height" value={`${summary.avg_apex_height} ft`} />
      <StatRow label="Ball Speed" value={`${summary.avg_ball_speed} m/s`} />
      <StatRow label="Release Time" value={`${summary.avg_release_time} sec`} />
      <StatRow label="Core Stability Score" value={`${(summary.core_stability_score * 100).toFixed(0)}%`} />

      <hr style={{ margin: '1rem 0' }} />
      <StatRow label="Shots Made" value={`${summary.made_count} / ${summary.shot_count}`} />
      <StatRow label="Session Time" value={`${summary.duration_seconds}s`} />
      <StatRow label="Surface" value={summary.surface_type} />
      <StatRow label="Environment" value={summary.indoor_outdoor} />

      {summary.user_notes && (
        <>
          <hr style={{ margin: '1rem 0' }} />
          <div style={{ fontWeight: 500 }}>User Notes:</div>
          <div style={{ fontStyle: 'italic' }}>{summary.user_notes}</div>
        </>
      )}
    </div>
  );
}
