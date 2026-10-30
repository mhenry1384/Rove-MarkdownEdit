use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Emitter, Manager, State};

const MAX_RECENT: usize = 30;
const RECENT_FILE: &str = "recent.json";

/// The file passed on the command line when this (first) instance launched.
/// The frontend takes it once on startup.
struct InitialFile(Mutex<Option<String>>);

/// Finds the first argument (after the exe) that names an existing file.
fn file_from_args(args: &[String], cwd: &Path) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        })
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn path_key(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

#[cfg(not(windows))]
fn path_key(p: &str) -> String {
    p.to_string()
}

// ---------- Recent files ----------

fn recent_store(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(RECENT_FILE))
}

fn load_recent(app: &AppHandle) -> Vec<String> {
    recent_store(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_recent(app: &AppHandle, list: &[String]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(recent_store(app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_recent_files(app: AppHandle) -> Vec<String> {
    load_recent(&app)
}

/// Moves (or inserts) `path` to the top of the recent list.
#[tauri::command]
fn add_recent_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let key = path_key(&path);
    let mut list = load_recent(&app);
    list.retain(|p| path_key(p) != key);
    list.insert(0, path);
    list.truncate(MAX_RECENT);
    save_recent(&app, &list)?;
    Ok(list)
}

#[tauri::command]
fn remove_recent_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let key = path_key(&path);
    let mut list = load_recent(&app);
    list.retain(|p| path_key(p) != key);
    save_recent(&app, &list)?;
    Ok(list)
}

// ---------- File I/O ----------

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn take_initial_file(state: State<InitialFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = file_from_args(&args, &cwd);

    tauri::Builder::default()
        // Must be registered first: a second launch hands its arguments to this
        // instance and then exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(path) = file_from_args(&argv, Path::new(&cwd)) {
                let _ = app.emit("open-file", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(InitialFile(Mutex::new(initial)))
        .invoke_handler(tauri::generate_handler![
            get_recent_files,
            add_recent_file,
            remove_recent_file,
            read_file,
            write_file,
            take_initial_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rove MarkdownEdit");
}
