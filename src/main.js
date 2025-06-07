import path from "../node_modules/path";
import express from '../node_modules/express';

const { invoke } = window.__TAURI__.core;

// Spotify API Configuration
const SPOTIFY_CONFIG = {
  clientId: '3fd7631171484ca1b2c76faeeccab147', // Ersetzen Sie dies mit Ihrer Client ID
  redirectUri: 'http://127.0.0.1:9843/callback', // Tauri dev server läuft auf 1420
  scopes: [
    'user-read-recently-played',
    'user-read-playback-state',
    'user-read-currently-playing'
  ]
};

let accessToken = null;
let allTracks = [];
let filteredTracks = [];
let currentFilter = 'all';

document.getElementById('loginBtn').addEventListener('click', () => {
  loginWithSpotify();
});

// Check if we're returning from Spotify auth
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code) {
    exchangeCodeForToken(code);
  } else {
    // Check for stored token
    const storedToken = localStorage.getItem('spotify_access_token');
    if (storedToken) {
      accessToken = storedToken;
      document.getElementById('authSection').style.display = 'none';
      loadSpotifyHistory();
    }
  }
});

function generateRandomState(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
      .map(x => chars.charAt(x % chars.length))
      .join('');
}

async function sendStateToServer(state) {
  try {
    const response = await fetch('https://api.nobrainclient.gg/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ state })
    });

    if (!response.ok) {
      throw new Error(`Server antwortet mit Status ${response.status}`);
    }
  } catch (error) {
    console.error('Fehler beim Senden des States:', error);
    throw error;
  }
}

async function startAuthServer(port = 9843) {

  const app = express();

  // Middleware setup
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  // Routes setup
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'callback.html'));
  });

  // Server starten
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`🌍 HTTP Server läuft auf Port ${port}`);
      console.log(`📱 Callback URL: http://localhost:${port}/callback.html`);
      console.log(`🔗 Oder einfach: http://localhost:${port}`);
      resolve(server);
    });
  });
}

async function loginWithSpotify() {
  const state = generateRandomState();

  // Start the auth server
  startAuthServer();

  try {


    const authUrl = `https://accounts.spotify.com/authorize?` +
        `response_type=code&` +
        `client_id=${SPOTIFY_CONFIG.clientId}&` +
        `scope=${SPOTIFY_CONFIG.scopes.join('%20')}&` +
        `redirect_uri=${encodeURIComponent(SPOTIFY_CONFIG.redirectUri)}` +
        `&state=${state}`;

    await invoke('open_spotify_url', { url: authUrl });
    await sendStateToServer(state);
  } catch (error) {
    console.error('Fehler beim Login-Prozess:', error);
    showError('Ein Fehler ist aufgetreten. Bitte versuchen Sie es später erneut.');
  }
}

async function exchangeCodeForToken(code) {
  try {
    showLoading('Authentifizierung läuft...');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIFY_CONFIG.redirectUri,
        client_id: SPOTIFY_CONFIG.clientId,
        client_secret: '50ece9d4a0d04fe2bc934fbd11985a6c' // In production: Server-side!
      })
    });

    const data = await response.json();

    if (data.access_token) {
      accessToken = data.access_token;
      localStorage.setItem('spotify_access_token', accessToken);

      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);

      document.getElementById('authSection').style.display = 'none';
      await loadSpotifyHistory();
    } else {
      throw new Error('Authentifizierung fehlgeschlagen');
    }
  } catch (error) {
    showError('Authentifizierung fehlgeschlagen: ' + error.message);
    hideLoading();
  }
}

async function loadSpotifyHistory() {
  try {
    showLoading('Lade Spotify-Historie...');
    allTracks = [];

    // Load recently played tracks (up to 50 at a time)
    let url = 'https://api.spotify.com/v1/me/player/recently-played?limit=50';
    let hasMore = true;
    let requestCount = 0;
    const maxRequests = 10; // Limit to prevent infinite loops

    while (hasMore && requestCount < maxRequests) {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Token expired
          localStorage.removeItem('spotify_access_token');
          location.reload();
          return;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      allTracks.push(...data.items);

      // Check if there are more tracks
      if (data.next && data.items.length === 50) {
        url = data.next;
        requestCount++;

        // Add small delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        hasMore = false;
      }
    }

    // Remove duplicates based on played_at timestamp
    allTracks = allTracks.filter((track, index, self) =>
        index === self.findIndex(t => t.played_at === track.played_at)
    );

    // Sort by played_at (newest first)
    allTracks.sort((a, b) => new Date(b.played_at) - new Date(a.played_at));

    filteredTracks = [...allTracks];
    displayTracks();
    displayStats();
    createFilters();
    hideLoading();

  } catch (error) {
    showError('Fehler beim Laden der Spotify-Historie: ' + error.message);
    hideLoading();
  }
}

function displayTracks() {
  const container = document.getElementById('tracksContainer');

  if (filteredTracks.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: #ccc;">Keine Tracks gefunden.</p>';
    return;
  }

  const tracksHtml = filteredTracks.map(item => {
    const track = item.track;
    const playedAt = new Date(item.played_at);
    const imageUrl = track.album.images[0]?.url || '';

    return `
            <div class="track-item">
                <img class="track-image" src="${imageUrl}" alt="${track.name}" 
                     onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjMwIiB5PSIzNSIgZmlsbD0iIzk5OSIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSI+4p2MPC90ZXh0Pgo8L3N2Zz4K'">
                <div class="track-info">
                    <div class="track-name">${track.name}</div>
                    <div class="track-artist">${track.artists.map(a => a.name).join(', ')}</div>
                    <div class="track-album">${track.album.name}</div>
                </div>
                <div class="track-played-at">
                    ${playedAt.toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })}<br>
                    ${playedAt.toLocaleTimeString('de-DE', {
      hour: '2-digit',
      minute: '2-digit'
    })}
                </div>
            </div>
        `;
  }).join('');

  container.innerHTML = `<div class="track-list">${tracksHtml}</div>`;
}

function displayStats() {
  const container = document.getElementById('statsContainer');

  const totalTracks = allTracks.length;
  const uniqueArtists = new Set(allTracks.flatMap(item => item.track.artists.map(a => a.name))).size;
  const uniqueAlbums = new Set(allTracks.map(item => item.track.album.name)).size;

  const oldestTrack = allTracks[allTracks.length - 1];
  const daysSinceOldest = oldestTrack ?
      Math.ceil((new Date() - new Date(oldestTrack.played_at)) / (1000 * 60 * 60 * 24)) : 0;

  container.innerHTML = `
        <div class="stats">
            <div class="stat-item">
                <div class="stat-number">${totalTracks}</div>
                <div class="stat-label">Gespielte Tracks</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${uniqueArtists}</div>
                <div class="stat-label">Verschiedene Künstler</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${uniqueAlbums}</div>
                <div class="stat-label">Verschiedene Alben</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${daysSinceOldest}</div>
                <div class="stat-label">Tage Historie</div>
            </div>
        </div>
    `;
}

function createFilters() {
  const container = document.getElementById('filterContainer');

  container.innerHTML = `
        <div class="filter-section">
            <button class="filter-btn active" onclick="filterTracks('all')">Alle</button>
            <button class="filter-btn" onclick="filterTracks('today')">Heute</button>
            <button class="filter-btn" onclick="filterTracks('yesterday')">Gestern</button>
            <button class="filter-btn" onclick="filterTracks('week')">Diese Woche</button>
            <button class="filter-btn" onclick="filterTracks('month')">Dieser Monat</button>
        </div>
    `;
}

function filterTracks(period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

  currentFilter = period;

  switch (period) {
    case 'today':
      filteredTracks = allTracks.filter(item =>
          new Date(item.played_at) >= today
      );
      break;
    case 'yesterday':
      filteredTracks = allTracks.filter(item => {
        const playedAt = new Date(item.played_at);
        return playedAt >= yesterday && playedAt < today;
      });
      break;
    case 'week':
      filteredTracks = allTracks.filter(item =>
          new Date(item.played_at) >= weekAgo
      );
      break;
    case 'month':
      filteredTracks = allTracks.filter(item =>
          new Date(item.played_at) >= monthAgo
      );
      break;
    default:
      filteredTracks = [...allTracks];
  }

  // Update filter button states
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  event.target.classList.add('active');

  displayTracks();
}

function showLoading(message) {
  document.getElementById('loadingContainer').innerHTML =
      `<div class="loading">${message}</div>`;
}

function hideLoading() {
  document.getElementById('loadingContainer').innerHTML = '';
}

function showError(message) {
  document.getElementById('errorContainer').innerHTML =
      `<div class="error">${message}</div>`;
}

// Auto-refresh token before it expires (if needed)
setInterval(() => {
  const token = localStorage.getItem('spotify_access_token');
  if (token && !accessToken) {
    accessToken = token;
    loadSpotifyHistory();
  }
}, 60000); // Check every minute

// Global functions for onclick handlers
window.loginWithSpotify = loginWithSpotify;
window.filterTracks = filterTracks;