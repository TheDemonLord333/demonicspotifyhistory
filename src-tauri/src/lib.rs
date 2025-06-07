use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize, Deserialize)]
struct SpotifyConfig {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}

// Command to get Spotify configuration (if needed)
#[tauri::command]
fn get_spotify_config() -> SpotifyConfig {
    SpotifyConfig {
        client_id: "3fd7631171484ca1b2c76faeeccab147".to_string(),
        client_secret: "50ece9d4a0d04fe2bc934fbd11985a6c".to_string(),
        redirect_uri: "http://127.0.0.1:9843/callback".to_string(),
    }
}

// Command to open Spotify OAuth URL in system browser
#[tauri::command]
async fn open_spotify_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
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
            open_spotify_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}