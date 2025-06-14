const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Spotify API Configuration
const SPOTIFY_CONFIG = {
    clientId: '3fd7631171484ca1b2c76faeeccab147',
    redirectUri: 'http://127.0.0.1:9843/callback', // Lokaler Server
    scopes: [
        'user-read-recently-played',
        'user-read-playback-state',
        'user-read-currently-playing'
    ]
};

// Debug: Check if Spotify config is set
console.log('Spotify Config:', SPOTIFY_CONFIG);

let accessToken = null;
let allTracks = [];
let filteredTracks = [];
let currentFilter = 'all';
let authState = null; // Store current auth state
let serverStarted = false;

// Generate random state for OAuth security
function generateRandomState() {
    const array = new Uint32Array(8);
    crypto.getRandomValues(array);
    return Array.from(array, dec => dec.toString(16)).join('');
}

// Setup event listeners for Tauri events
async function setupEventListeners() {
    // Listen for successful authentication
    await listen('spotify-auth-success', (event) => {
        console.log('Received auth success event:', event.payload);
        const { code, state } = event.payload;

        // Validate state parameter for security
        if (authState && state !== authState) {
            console.error('State parameter mismatch! Possible CSRF attack.');
            showError('⚠️ Sicherheitsfehler: State parameter stimmt nicht überein. Bitte versuchen Sie es erneut.');
            return;
        }

        // Exchange code for token
        exchangeCodeForToken(code);
    });

    // Listen for authentication errors
    await listen('spotify-auth-error', (event) => {
        console.log('Received auth error event:', event.payload);
        showError(`Authentifizierung fehlgeschlagen: ${event.payload.error}`);
        hideLoading();
    });
}

// Setup button event listener
document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('loginBtn').addEventListener('click', () => {
        loginWithSpotify();
    });

    // Setup Tauri event listeners
    await setupEventListeners();

    // Check for stored token
    const storedToken = localStorage.getItem('spotify_access_token');
    if (storedToken) {
        accessToken = storedToken;
        document.getElementById('authSection').style.display = 'none';
        loadSpotifyHistory();
    }
});

async function loginWithSpotify() {
    console.log('Login button clicked!');

    try {
        // Start the callback server if not already started
        if (!serverStarted) {
            console.log('Starting callback server...');
            const port = await invoke('start_callback_server');
            console.log(`Callback server started on port ${port}`);
            serverStarted = true;

            // Wait a moment for server to be ready
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Generate random state for security
        authState = generateRandomState();
        console.log('Generated auth state:', authState);

        const authUrl = `https://accounts.spotify.com/authorize?` +
            `response_type=code&` +
            `client_id=${SPOTIFY_CONFIG.clientId}&` +
            `scope=${SPOTIFY_CONFIG.scopes.join('%20')}&` +
            `redirect_uri=${encodeURIComponent(SPOTIFY_CONFIG.redirectUri)}` +
            `&state=${authState}`;

        console.log('Opening Spotify Auth URL:', authUrl);

        // Use Tauri's opener plugin to open URL in system browser
        await invoke('open_spotify_url', { url: authUrl });
        console.log('Successfully opened URL');
        showLoading('Browser geöffnet - Bitte melden Sie sich bei Spotify an...');

    } catch (error) {
        console.error('Failed to start login process:', error);
        showError(`Fehler beim Login-Prozess: ${error.message || error}`);
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
                redirect_uri: SPOTIFY_CONFIG.redirectUri, // Muss exakt mit der in Spotify App übereinstimmen!
                client_id: SPOTIFY_CONFIG.clientId,
                client_secret: '50ece9d4a0d04fe2bc934fbd11985a6c' // In production: Server-side!
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('Token exchange failed:', response.status, errorData);
            throw new Error(`HTTP ${response.status}: ${errorData}`);
        }

        const data = await response.json();

        if (data.access_token) {
            accessToken = data.access_token;
            localStorage.setItem('spotify_access_token', accessToken);

            document.getElementById('authSection').style.display = 'none';
            await loadSpotifyHistory();
        } else {
            throw new Error('Authentifizierung fehlgeschlagen: Kein Access Token erhalten');
        }
    } catch (error) {
        console.error('Exchange token error:', error);
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