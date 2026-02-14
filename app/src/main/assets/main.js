// Spotify API Configuration
const SPOTIFY_CONFIG = {
    clientId: '3fd7631171484ca1b2c76faeeccab147',
    redirectUri: 'demonicspotifyhistory://callback',
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
let authState = null;

// Generate random state for OAuth security
function generateRandomState() {
    const array = new Uint32Array(8);
    crypto.getRandomValues(array);
    return Array.from(array, dec => dec.toString(16)).join('');
}

// Called from Android native code when OAuth callback succeeds
function onSpotifyAuthSuccess(code, state) {
    console.log('Received auth success from Android:', code ? 'code received' : 'no code');

    // Validate state parameter for security
    if (authState && state !== authState) {
        console.error('State parameter mismatch! Possible CSRF attack.');
        showError('Sicherheitsfehler: State parameter stimmt nicht überein. Bitte versuchen Sie es erneut.');
        hideLoading();
        return;
    }

    // Exchange code for token
    exchangeCodeForToken(code);
}

// Called from Android native code when OAuth callback has an error
function onSpotifyAuthError(error) {
    console.log('Received auth error from Android:', error);
    showError('Authentifizierung fehlgeschlagen: ' + error);
    hideLoading();
}

// Setup button event listener
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('loginBtn').addEventListener('click', function() {
        loginWithSpotify();
    });

    // Check for stored token
    const storedToken = localStorage.getItem('spotify_access_token');
    if (storedToken) {
        accessToken = storedToken;
        document.getElementById('authSection').style.display = 'none';
        loadSpotifyHistory();
    }
});

function loginWithSpotify() {
    console.log('Login button clicked!');

    try {
        // Generate random state for security
        authState = generateRandomState();
        localStorage.setItem('spotify_auth_state', authState);
        console.log('Generated auth state:', authState);

        var authUrl = 'https://accounts.spotify.com/authorize?' +
            'response_type=code&' +
            'client_id=' + SPOTIFY_CONFIG.clientId + '&' +
            'scope=' + SPOTIFY_CONFIG.scopes.join('%20') + '&' +
            'redirect_uri=' + encodeURIComponent(SPOTIFY_CONFIG.redirectUri) +
            '&state=' + authState;

        console.log('Opening Spotify Auth URL');
        showLoading('Browser wird geoeffnet - Bitte melden Sie sich bei Spotify an...');

        // Use Android bridge to open URL in Chrome Custom Tab
        if (typeof Android !== 'undefined') {
            Android.openUrl(authUrl);
        } else {
            // Fallback for testing in browser
            window.open(authUrl, '_blank');
        }

    } catch (error) {
        console.error('Failed to start login process:', error);
        showError('Fehler beim Login-Prozess: ' + (error.message || error));
    }
}

function exchangeCodeForToken(code) {
    showLoading('Authentifizierung laeuft...');

    // NOTE: redirect_uri must match exactly what is registered in your Spotify Developer Dashboard.
    // For Android, register: demonicspotifyhistory://callback
    fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: SPOTIFY_CONFIG.redirectUri,
            client_id: SPOTIFY_CONFIG.clientId,
            client_secret: '50ece9d4a0d04fe2bc934fbd11985a6c'
        }).toString()
    })
    .then(function(response) {
        if (!response.ok) {
            return response.text().then(function(errorData) {
                throw new Error('HTTP ' + response.status + ': ' + errorData);
            });
        }
        return response.json();
    })
    .then(function(data) {
        if (data.access_token) {
            accessToken = data.access_token;
            localStorage.setItem('spotify_access_token', accessToken);
            document.getElementById('authSection').style.display = 'none';
            loadSpotifyHistory();
        } else {
            throw new Error('Authentifizierung fehlgeschlagen: Kein Access Token erhalten');
        }
    })
    .catch(function(error) {
        console.error('Exchange token error:', error);
        showError('Authentifizierung fehlgeschlagen: ' + error.message);
        hideLoading();
    });
}

function loadSpotifyHistory() {
    showLoading('Lade Spotify-Historie...');
    allTracks = [];

    var url = 'https://api.spotify.com/v1/me/player/recently-played?limit=50';
    var requestCount = 0;
    var maxRequests = 10;

    function fetchPage(pageUrl) {
        fetch(pageUrl, {
            headers: {
                'Authorization': 'Bearer ' + accessToken
            }
        })
        .then(function(response) {
            if (!response.ok) {
                if (response.status === 401) {
                    localStorage.removeItem('spotify_access_token');
                    location.reload();
                    return;
                }
                throw new Error('HTTP ' + response.status + ': ' + response.statusText);
            }
            return response.json();
        })
        .then(function(data) {
            if (!data) return;

            allTracks = allTracks.concat(data.items);

            if (data.next && data.items.length === 50 && requestCount < maxRequests) {
                requestCount++;
                setTimeout(function() {
                    fetchPage(data.next);
                }, 100);
            } else {
                finishLoading();
            }
        })
        .catch(function(error) {
            showError('Fehler beim Laden der Spotify-Historie: ' + error.message);
            hideLoading();
        });
    }

    function finishLoading() {
        // Remove duplicates based on played_at timestamp
        allTracks = allTracks.filter(function(track, index, self) {
            return index === self.findIndex(function(t) {
                return t.played_at === track.played_at;
            });
        });

        // Sort by played_at (newest first)
        allTracks.sort(function(a, b) {
            return new Date(b.played_at) - new Date(a.played_at);
        });

        filteredTracks = allTracks.slice();
        displayTracks();
        displayStats();
        createFilters();
        hideLoading();
    }

    fetchPage(url);
}

function displayTracks() {
    var container = document.getElementById('tracksContainer');

    if (filteredTracks.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: #ccc;">Keine Tracks gefunden.</p>';
        return;
    }

    var tracksHtml = filteredTracks.map(function(item) {
        var track = item.track;
        var playedAt = new Date(item.played_at);
        var imageUrl = (track.album.images[0] && track.album.images[0].url) || '';
        var artists = track.artists.map(function(a) { return a.name; }).join(', ');

        var dateStr = playedAt.toLocaleDateString('de-DE', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
        var timeStr = playedAt.toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit'
        });

        return '<div class="track-item">' +
            '<img class="track-image" src="' + imageUrl + '" alt="' + escapeHtml(track.name) + '" ' +
            'onerror="this.src=\'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiBmaWxsPSIjMzMzIi8+Cjx0ZXh0IHg9IjMwIiB5PSIzNSIgZmlsbD0iIzk5OSIgZm9udC1zaXplPSIxMiIgdGV4dC1hbmNob3I9Im1pZGRsZSI+4p2MPC90ZXh0Pgo8L3N2Zz4K\'">' +
            '<div class="track-info">' +
            '<div class="track-name">' + escapeHtml(track.name) + '</div>' +
            '<div class="track-artist">' + escapeHtml(artists) + '</div>' +
            '<div class="track-album">' + escapeHtml(track.album.name) + '</div>' +
            '</div>' +
            '<div class="track-played-at">' + dateStr + '<br>' + timeStr + '</div>' +
            '</div>';
    }).join('');

    container.innerHTML = '<div class="track-list">' + tracksHtml + '</div>';
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
}

function displayStats() {
    var container = document.getElementById('statsContainer');

    var totalTracks = allTracks.length;

    var artistSet = {};
    var albumSet = {};
    allTracks.forEach(function(item) {
        item.track.artists.forEach(function(a) {
            artistSet[a.name] = true;
        });
        albumSet[item.track.album.name] = true;
    });
    var uniqueArtists = Object.keys(artistSet).length;
    var uniqueAlbums = Object.keys(albumSet).length;

    var oldestTrack = allTracks[allTracks.length - 1];
    var daysSinceOldest = oldestTrack ?
        Math.ceil((new Date() - new Date(oldestTrack.played_at)) / (1000 * 60 * 60 * 24)) : 0;

    container.innerHTML =
        '<div class="stats">' +
        '<div class="stat-item">' +
        '<div class="stat-number">' + totalTracks + '</div>' +
        '<div class="stat-label">Gespielte Tracks</div>' +
        '</div>' +
        '<div class="stat-item">' +
        '<div class="stat-number">' + uniqueArtists + '</div>' +
        '<div class="stat-label">Verschiedene Kuenstler</div>' +
        '</div>' +
        '<div class="stat-item">' +
        '<div class="stat-number">' + uniqueAlbums + '</div>' +
        '<div class="stat-label">Verschiedene Alben</div>' +
        '</div>' +
        '<div class="stat-item">' +
        '<div class="stat-number">' + daysSinceOldest + '</div>' +
        '<div class="stat-label">Tage Historie</div>' +
        '</div>' +
        '</div>';
}

function createFilters() {
    var container = document.getElementById('filterContainer');

    container.innerHTML =
        '<div class="filter-section">' +
        '<button class="filter-btn active" onclick="filterTracks(\'all\', this)">Alle</button>' +
        '<button class="filter-btn" onclick="filterTracks(\'today\', this)">Heute</button>' +
        '<button class="filter-btn" onclick="filterTracks(\'yesterday\', this)">Gestern</button>' +
        '<button class="filter-btn" onclick="filterTracks(\'week\', this)">Diese Woche</button>' +
        '<button class="filter-btn" onclick="filterTracks(\'month\', this)">Dieser Monat</button>' +
        '</div>';
}

function filterTracks(period, btnElement) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    var weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    var monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    currentFilter = period;

    switch (period) {
        case 'today':
            filteredTracks = allTracks.filter(function(item) {
                return new Date(item.played_at) >= today;
            });
            break;
        case 'yesterday':
            filteredTracks = allTracks.filter(function(item) {
                var playedAt = new Date(item.played_at);
                return playedAt >= yesterday && playedAt < today;
            });
            break;
        case 'week':
            filteredTracks = allTracks.filter(function(item) {
                return new Date(item.played_at) >= weekAgo;
            });
            break;
        case 'month':
            filteredTracks = allTracks.filter(function(item) {
                return new Date(item.played_at) >= monthAgo;
            });
            break;
        default:
            filteredTracks = allTracks.slice();
    }

    // Update filter button states
    var buttons = document.querySelectorAll('.filter-btn');
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.remove('active');
    }
    if (btnElement) {
        btnElement.classList.add('active');
    }

    displayTracks();
}

function showLoading(message) {
    document.getElementById('loadingContainer').innerHTML =
        '<div class="loading">' + message + '</div>';
}

function hideLoading() {
    document.getElementById('loadingContainer').innerHTML = '';
}

function showError(message) {
    document.getElementById('errorContainer').innerHTML =
        '<div class="error">' + message + '</div>';
}

// Auto-refresh token check
setInterval(function() {
    var token = localStorage.getItem('spotify_access_token');
    if (token && !accessToken) {
        accessToken = token;
        loadSpotifyHistory();
    }
}, 60000);
