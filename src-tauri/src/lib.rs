use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use warp::Filter;
use tauri::Emitter;

#[derive(Debug, Serialize, Deserialize)]
struct SpotifyConfig {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CallbackData {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

// Global storage for callback data
type CallbackStorage = Arc<Mutex<Option<CallbackData>>>;

// Command to get Spotify configuration
#[tauri::command]
fn get_spotify_config() -> SpotifyConfig {
    SpotifyConfig {
        client_id: "3fd7631171484ca1b2c76faeeccab147".to_string(),
        client_secret: "50ece9d4a0d04fe2bc934fbd11985a6c".to_string(),
        redirect_uri: "http://127.0.0.1:9843/callback".to_string(),
    }
}

// Command to start the local HTTP server
#[tauri::command]
async fn start_callback_server(app: tauri::AppHandle) -> Result<u16, String> {
    let callback_storage: CallbackStorage = Arc::new(Mutex::new(None));
    let callback_storage_filter = warp::any().map({
        let storage = callback_storage.clone();
        move || storage.clone()
    });

    // CORS headers
    let cors = warp::cors()
        .allow_any_origin()
        .allow_headers(vec!["content-type"])
        .allow_methods(vec!["GET", "POST", "OPTIONS"]);

    // Health check endpoint
    let health = warp::path("health")
        .and(warp::get())
        .map(|| {
            warp::reply::json(&serde_json::json!({
                "status": "healthy",
                "timestamp": chrono::Utc::now().to_rfc3339()
            }))
        });

    // Callback endpoint that receives the Spotify redirect
    let callback = warp::path("callback")
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(callback_storage_filter.clone())
        .and_then(move |params: HashMap<String, String>, storage: CallbackStorage| {
            let app_handle = app.clone();
            async move {
                let callback_data = CallbackData {
                    code: params.get("code").cloned(),
                    state: params.get("state").cloned(),
                    error: params.get("error").cloned(),
                };

                // Store the callback data
                {
                    let mut guard = storage.lock().await;
                    *guard = Some(callback_data.clone());
                }

                // Emit event to frontend
                if let Some(code) = &callback_data.code {
                    let _ = app_handle.emit("spotify-auth-success", serde_json::json!({
                        "code": code,
                        "state": callback_data.state
                    }));
                } else if let Some(error) = &callback_data.error {
                    let _ = app_handle.emit("spotify-auth-error", serde_json::json!({
                        "error": error
                    }));
                }

                // Return a nice HTML page
                let html = format!(r#"
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Spotify Authentifizierung</title>
    <style>
        body {{
            font-family: 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #1DB954 0%, #1ed760 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0;
            color: white;
        }}
        .container {{
            background: rgba(0,0,0,0.8);
            padding: 2rem;
            border-radius: 20px;
            text-align: center;
            max-width: 400px;
            backdrop-filter: blur(10px);
        }}
        .success {{ color: #1DB954; font-size: 3rem; margin-bottom: 1rem; }}
        .error {{ color: #ff6b6b; font-size: 3rem; margin-bottom: 1rem; }}
        h1 {{ margin-bottom: 1rem; }}
        p {{ opacity: 0.9; line-height: 1.5; }}
        .code {{
            background: rgba(29,185,84,0.1);
            padding: 1rem;
            border-radius: 10px;
            margin: 1rem 0;
            font-family: monospace;
            word-break: break-all;
        }}
    </style>
</head>
<body>
    <div class="container">
        {}
    </div>
    <script>
        // Auto-close after 3 seconds
        setTimeout(() => {{
            window.close();
        }}, 3000);
    </script>
</body>
</html>
                "#, if callback_data.code.is_some() {
                    format!(r#"
                        <div class="success">✅</div>
                        <h1>Erfolgreich!</h1>
                        <p>Die Authentifizierung war erfolgreich.<br>
                        Sie können dieses Fenster schließen.</p>
                        <div class="code">Code: {}</div>
                        <p>Dieses Fenster schließt sich automatisch...</p>
                    "#, callback_data.code.as_ref().unwrap_or(&"N/A".to_string()))
                } else {
                    format!(r#"
                        <div class="error">❌</div>
                        <h1>Fehler</h1>
                        <p>Bei der Authentifizierung ist ein Fehler aufgetreten:<br>
                        {}</p>
                    "#, callback_data.error.as_ref().unwrap_or(&"Unbekannter Fehler".to_string()))
                });

                Ok::<_, warp::Rejection>(warp::reply::html(html))
            }
        });

    // Endpoint to get callback data (for polling)
    let get_callback = warp::path("get-callback")
        .and(warp::get())
        .and(callback_storage_filter)
        .and_then(|storage: CallbackStorage| async move {
            let guard = storage.lock().await;
            match guard.as_ref() {
                Some(data) => Ok::<_, warp::Rejection>(warp::reply::json(data)),
                None => Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({"status": "waiting"}))),
            }
        });

    let routes = health
        .or(callback)
        .or(get_callback)
        .with(cors);

    // Start server on available port
    let port = 9843u16;
    tokio::spawn(async move {
        println!("🚀 Starting callback server on port {}", port);
        warp::serve(routes)
            .run(([127, 0, 0, 1], port))
            .await;
    });

    Ok(port)
}

// Command to get callback data
#[tauri::command]
async fn get_callback_data() -> Result<Option<CallbackData>, String> {
    // This would need to be implemented with actual storage
    // For now, we'll rely on the event system
    Ok(None)
}

// Command to open Spotify OAuth URL in system browser
#[tauri::command]
async fn open_spotify_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// Basic greet command (keep existing functionality)
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_spotify_config,
            open_spotify_url,
            start_callback_server,
            get_callback_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}