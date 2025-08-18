
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import HomePage from './components/HomePage';
import CoachSession from './components/CoachSession';
import CommunityFeed from './components/CommunityFeed';
import SettingsPage from './components/SettingsPage';

export default function App() {
  return (
    <Router>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <nav style={{ display: 'flex', justifyContent: 'space-around', padding: '1rem', background: '#222', color: '#fff' }}>
          <Link to="/" style={linkStyle}>🏠 Home</Link>
          <Link to="/session" style={linkStyle}>🎯 Coach</Link>
          <Link to="/community" style={linkStyle}>🌍 Community</Link>
          <Link to="/settings" style={linkStyle}>⚙️ Settings</Link>
        </nav>
        <div style={{ flex: 1 }}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/session" element={<CoachSession />} />
            <Route path="/community" element={<CommunityFeed />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

const linkStyle = {
  color: 'white',
  textDecoration: 'none',
  fontWeight: 'bold'
};
