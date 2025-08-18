// VideoPlayerModal.jsx
import React from 'react';

export default function VideoPlayerModal({ session, onClose }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.8)',
      display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: '#fff',
        padding: '1rem',
        borderRadius: '10px',
        maxWidth: '600px',
        width: '100%'
      }}>
        <h3>{session.user}'s Session</h3>
        <video src={session.video_url} controls autoPlay width="100%" />
        <div style={{ marginTop: '1rem' }}>
          <strong>Feedback:</strong>
          <p>{session.summary.user_notes || 'No additional notes.'}</p>
          <button onClick={onClose} style={{ marginTop: '1rem' }}>Close</button>
        </div>
      </div>
    </div>
  );
}
