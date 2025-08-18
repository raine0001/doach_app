// feedLoader.js
// Load from local stremioExport.json for development
async function loadFeed() {
  const container = document.getElementById('feedContainer');
  const template = document.getElementById('videoCard');
  container.innerHTML = '';

  const localJson = await fetch('/static/stremioExport.json');
  const raw = await localJson.json();

  const sessions = raw.libraryItems || raw.items || [];

  sessions.forEach(session => {
    const node = template.content.cloneNode(true);
    const video = node.querySelector('video');
    const user = node.querySelector('.uploader');
    const date = node.querySelector('.date');
    const notes = node.querySelector('.notes');

    video.src = session.meta?.trailer || session.video || '';
    video.poster = session.meta?.poster || '';
    user.textContent = session.user || session.meta?.name || 'Anonymous';
    date.textContent = new Date(session.timestamp || Date.now()).toLocaleString();
    notes.textContent = session.description || session.meta?.description || '';

    container.appendChild(node);
  });
}