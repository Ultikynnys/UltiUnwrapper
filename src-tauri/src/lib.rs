use std::fs;
use std::path::PathBuf;
use tauri::Manager;

mod cli;

/// Desktop app-data storage: settings and unwrap presets live as files in the
/// installation folder (`resource_dir()`, next to UltiUnwrapper.exe) when it is
/// writable, and otherwise in the per-user app-data dir. Data is organized as
/// `config/settings.json` and `presets/<name>.json`.
fn storage_dir(app: &tauri::AppHandle, location: &str) -> Result<PathBuf, String> {
    let dir = match location {
        "install" => app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?,
        "appdata" => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
        _ => return Err("Unknown storage location.".to_string()),
    };
    Ok(dir)
}

/// Storage paths are folder-qualified names: an optional known folder
/// ("config" | "presets") plus a plain file name. No deeper path, separator,
/// dotfile, or Windows-forbidden character can smuggle a traversal through.
fn validate_storage_file_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 160 || path.starts_with('.') || path.contains('\\') {
        return Err("Invalid storage file path.".to_string());
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() > 2 {
        return Err("Invalid storage file path.".to_string());
    }
    let file = match segments.as_slice() {
        [name] => *name,
        [folder, name] => {
            if !matches!(*folder, "config" | "presets") {
                return Err("Invalid storage folder.".to_string());
            }
            *name
        }
        _ => return Err("Invalid storage file path.".to_string()),
    };
    if file.is_empty()
        || file.len() > 120
        || file.starts_with('.')
        || file
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err("Invalid storage file name.".to_string());
    }
    Ok(())
}

fn storage_file_path(app: &tauri::AppHandle, location: &str, file: &str) -> Result<PathBuf, String> {
    validate_storage_file_path(file)?;
    let dir = storage_dir(app, location)?;
    match file.split_once('/') {
        Some((folder, name)) => Ok(dir.join(folder).join(name)),
        None => Ok(dir.join(file)),
    }
}

#[tauri::command]
fn app_storage_dir(app: tauri::AppHandle, location: String) -> Result<String, String> {
    storage_dir(&app, &location).map(|dir| dir.to_string_lossy().to_string())
}

#[tauri::command]
fn read_app_data(app: tauri::AppHandle, location: String, file: String) -> Result<Option<String>, String> {
    let path = storage_file_path(&app, &location, &file)?;
    match fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {}", path.display(), error)),
    }
}

#[tauri::command]
fn write_app_data(app: tauri::AppHandle, location: String, file: String, contents: String) -> Result<(), String> {
    let path = storage_file_path(&app, &location, &file)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {}", parent.display(), error))?;
    }
    fs::write(&path, contents).map_err(|error| format!("Could not write {}: {}", path.display(), error))
}

#[tauri::command]
fn remove_app_data(app: tauri::AppHandle, location: String, file: String) -> Result<(), String> {
    let path = storage_file_path(&app, &location, &file)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove {}: {}", path.display(), error)),
    }
}

#[tauri::command]
fn list_app_data(app: tauri::AppHandle, location: String, folder: String) -> Result<Vec<String>, String> {
    if !matches!(folder.as_str(), "config" | "presets") {
        return Err("Unknown storage folder.".to_string());
    }
    let dir = storage_dir(&app, &location)?.join(&folder);
    let mut names: Vec<String> = Vec::new();
    match fs::read_dir(&dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .map(|file_type| file_type.is_file())
                    .unwrap_or(false)
                {
                    names.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not list {}: {}", dir.display(), error)),
    }
    names.sort();
    Ok(names)
}

/// The desktop shell is deliberately minimal. A bare launch shows the app
/// window; any argument selects CLI mode and opens the hidden CLI webview.
pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli_mode = !args.is_empty();
    if cli_mode {
        cli::attach_parent_console();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            app_storage_dir,
            read_app_data,
            write_app_data,
            remove_app_data,
            list_app_data,
            cli::cli_args,
            cli::cli_read_file,
            cli::cli_write_file,
            cli::cli_log,
            cli::cli_error,
            cli::cli_cwd,
            cli::cli_exit
        ])
        .setup(move |app| {
            app.manage(cli::CliArgs(args));

            if cli_mode {
                tauri::WebviewWindowBuilder::new(app, "cli", tauri::WebviewUrl::App("cli.html".into()))
                    .title("UltiUnwrapper CLI")
                    .visible(false)
                    .skip_taskbar(true)
                    .disable_drag_drop_handler()
                    .on_navigation(|url| {
                        matches!(
                            url.scheme(),
                            "http" | "https" | "tauri" | "blob" | "data" | "about"
                        )
                    })
                    .build()?;
            } else {
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("UltiUnwrapper")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 600.0)
                    .resizable(true)
                    .disable_drag_drop_handler()
                    .on_navigation(|url| {
                        matches!(
                            url.scheme(),
                            "http" | "https" | "tauri" | "blob" | "data" | "about"
                        )
                    })
                    .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
