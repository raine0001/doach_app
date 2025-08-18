import React, { useState } from 'react';

const predefinedTags = [
  "arc", "elbow", "knees", "follow-through", "release angle", "high apex", "consistency"
];

export default function ShareMenu({ onDownload, onUpload }) {
  const [selectedTags, setSelectedTags] = useState([]);
  const [privacy, setPrivacy] = useState("public"); // "private" or "public"
  const [notes, setNotes] = useState("");

  const toggleTag = (tag) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter(t => t !== tag));
    } else {
      setSelectedTags([...selectedTags, tag]);
    }
  };

  const handleUpload = () => {
    onUpload({
      privacy,
      tags: selectedTags,
      userNotes: notes
    });
  };

  return (
    <div style={wrapper}>
      <h3>📤 Share Your Session</h3>

      <button onClick={onDownload} style={button("#007bff")}>
        ⬇ Download Video
      </button>

      <div style={{ marginTop: '1rem' }}>
        <strong>Tags:</strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
          {predefinedTags.map(tag => (
            <div
              key={tag}
              onClick={() => toggleTag(tag)}
              style={{
                padding: '0.4rem 0.8rem',
                background: selectedTags.includes(tag) ? '#28a745' : '#eee',
                color: selectedTags.includes(tag) ? '#fff' : '#333',
                borderRadius: '20px',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}
            >
              #{tag}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <strong>Privacy:</strong>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
          <label>
            <input
              type="radio"
              name="privacy"
              checked={privacy === "public"}
              onChange={() => setPrivacy("public")}
            /> Public
          </label>
          <label>
            <input
              type="radio"
              name="privacy"
              checked={privacy === "private"}
              onChange={() => setPrivacy("private")}
            /> Private
          </label>
        </div>
      </div>

      <div style={{ marginTop: '1rem' }}>
        <strong>Notes:</strong>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{
            width: '100%',
            padding: '0.5rem',
            marginTop: '0.5rem',
            borderRadius: '8px',
            border: '1px solid #ccc'
          }}
          placeholder="What do you want others (or yourself) to remember about this session?"
        />
      </div>

      <button onClick={handleUpload} style={button("#28a745")}>
        {privacy === "private" ? "🔒 Upload Private" : "🌍 Post to Community"}
      </button>
    </div>
  );
}

const wrapper = {
  background: '#fff',
  borderRadius: '12px',
  padding: '1.2rem',
  boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  maxWidth: '450px',
  margin: '2rem auto',
  textAlign: 'center',
  color: '#000'
};

const button = (color) => ({
  backgroundColor: color,
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  padding: '0.75rem 1.5rem',
  margin: '1rem 0',
  width: '100%',
  fontSize: '1rem',
  cursor: 'pointer'
});
