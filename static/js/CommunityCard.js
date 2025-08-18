import React, { useState } from 'react';
import VideoPlayerModal from './video_utils';

export default function CommunityCard({ session }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div onClick={() => setOpen(true)} style={{
        backgroundColor: '#fff',
        padding: '0.5rem',
        borderRadius: '8px',
        boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
        cursor: 'pointer'
      }}>
        <video src={session.video_url} muted width="100%" style={{ borderRadius: '4px' }} />
        <div style={{ fontWeight: 600, marginTop: '0.5rem' }}>{session.user || 'Anonymous Player'}</div>
        <div style={{ fontSize: '0.9rem', color: '#666' }}>
          🎯 {session.summary.made_percentage * 100}% made<br />
          📐 Angle: {session.summary.avg_release_angle}°<br />
          🏷️ {session.tags.map(t => `#${t}`).join(' ')}
        </div>
      </div>

      {open && <VideoPlayerModal session={session} onClose={() => setOpen(false)} />}
    </>
  );
}
