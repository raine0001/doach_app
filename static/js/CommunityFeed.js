import React, { useState, useEffect } from 'react';
import CommunityCard from './CommunityCard';

export default function CommunityFeed() {
  const [sessions, setSessions] = useState([]);
  const [activeTag, setActiveTag] = useState(null);

  useEffect(() => {
    fetch('https://your-api.com/community-sessions')
      .then(res => res.json())
      .then(data => setSessions(data));
  }, []);

  const filteredSessions = activeTag
    ? sessions.filter(s => s.tags.includes(activeTag))
    : sessions;

  const uniqueTags = [...new Set(sessions.flatMap(s => s.tags))];

  return (
    <div style={{ padding: '1rem', maxWidth: '1000px', margin: '0 auto' }}>
      <h2>🏀 DOACH Community Sessions</h2>

      <div style={{ margin: '1rem 0' }}>
        <strong>Filter by tag:</strong>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {uniqueTags.map(tag => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              style={{
                padding: '0.3rem 0.8rem',
                borderRadius: '20px',
                border: '1px solid #ccc',
                backgroundColor: tag === activeTag ? '#28a745' : '#eee',
                color: tag === activeTag ? '#fff' : '#000',
                cursor: 'pointer'
              }}
            >
              #{tag}
            </button>
          ))}
          {activeTag && (
            <button onClick={() => setActiveTag(null)} style={{ marginLeft: '1rem' }}>
              ✕ Clear Filter
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {filteredSessions.map(session => (
          <CommunityCard key={session.id} session={session} />
        ))}
      </div>
    </div>
  );
}
