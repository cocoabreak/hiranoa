use super::normalize_path_for_display;
use super::persistent_trust::{persist_explorer_root, ExplorerRoot, PersistentExplorerRoot};
use super::trusted_paths::{AllowedRoots, ShareQuery};
use crate::commands::has_markdown_extension;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub struct NativeDialogState(AtomicBool);

impl NativeDialogState {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    pub(crate) fn try_acquire(&self) -> Result<NativeDialogGuard<'_>, String> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "別のダイアログを表示中です".to_string())?;
        Ok(NativeDialogGuard(&self.0))
    }
}

pub(crate) struct NativeDialogGuard<'a>(&'a AtomicBool);

impl Drop for NativeDialogGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

enum ShareGrant {
    Folder,
    FolderOrContainingFolder,
    Archive,
}

fn confirm_share_query(app: &AppHandle, path: &Path, grant: ShareGrant) -> bool {
    let path = normalize_path_for_display(path);
    let locale = crate::menu::resolve_locale(app);
    let (title, prompt) = if locale == "ja" {
        let scope = match grant {
            ShareGrant::Folder => "このフォルダー内のファイル",
            ShareGrant::FolderOrContainingFolder => {
                "フォルダー（ファイルを指定した場合はその親フォルダー）内のファイル"
            }
            ShareGrant::Archive => "このアーカイブファイル",
        };
        (
            "ネットワーク共有への接続確認",
            format!("Windows が次のネットワーク共有パスに接続することを許可しますか？\n許可すると、{scope}にアクセスできます。\n\n{path}"),
        )
    } else {
        let scope = match grant {
            ShareGrant::Folder => "files in this folder",
            ShareGrant::FolderOrContainingFolder => {
                "files in the folder (or the containing folder for a file)"
            }
            ShareGrant::Archive => "this archive file",
        };
        (
            "Confirm network share access",
            format!("Allow Windows to connect to this network path?\nThis grants access to {scope}.\n\n{path}"),
        )
    };
    app.dialog()
        .message(prompt)
        .title(title)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show()
}

fn query_share_authorization<'a>(
    state: &AllowedRoots,
    app: &AppHandle,
    dialogs: &'a NativeDialogState,
    path: &str,
    grant: ShareGrant,
) -> Result<(ShareQuery, Option<NativeDialogGuard<'a>>), String> {
    // Keep the native dialog slot through registration and any persistent update.
    let mut guard = None;
    let query = state.query_share(path, |target| {
        guard = Some(dialogs.try_acquire()?);
        Ok(confirm_share_query(app, target, grant))
    })?;
    Ok((query, guard))
}

/// 未認可のパスについてネイティブ確認を表示し、承認された場合だけ信頼登録する。
/// WebViewはこの確認を迂回して信頼範囲を拡張できない。
#[tauri::command]
pub async fn authorize_path(
    app: AppHandle,
    path: String,
    state: State<'_, AllowedRoots>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<bool, String> {
    let (share, _share_guard) = query_share_authorization(
        &state,
        &app,
        &dialogs,
        &path,
        ShareGrant::FolderOrContainingFolder,
    )?;
    match share {
        ShareQuery::Declined => return Ok(false),
        ShareQuery::Trusted(_) => return Ok(true),
        ShareQuery::Confirmed(canonical) => {
            state.register_root_path(AllowedRoots::root_for_canonical_path(canonical)?);
            return Ok(true);
        }
        ShareQuery::Local => {}
    }
    if state.is_allowed(&path) {
        return Ok(true);
    }

    let root = AllowedRoots::root_for_path(&path)?;
    let _dialog_guard = dialogs.try_acquire()?;
    let locale = crate::menu::resolve_locale(&app);
    let display_root = normalize_path_for_display(&root);
    let (title, prompt) = if locale == "ja" {
        (
            "フォルダーへのアクセス確認",
            format!(
                "次のフォルダー内のファイルへのアクセスを許可しますか？\n\n{}",
                display_root
            ),
        )
    } else {
        (
            "Confirm folder access",
            format!("Allow access to files in this folder?\n\n{}", display_root),
        )
    };

    let approved = app
        .dialog()
        .message(prompt)
        .title(title)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if approved {
        state.register_root_path(root);
    }
    Ok(approved)
}

/// ZIPアーカイブ単体の認可。親フォルダーへ信頼範囲を広げない。
#[tauri::command]
pub async fn authorize_archive_path(
    app: AppHandle,
    path: String,
    state: State<'_, AllowedRoots>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<bool, String> {
    let (share, _share_guard) =
        query_share_authorization(&state, &app, &dialogs, &path, ShareGrant::Archive)?;
    match share {
        ShareQuery::Declined => return Ok(false),
        ShareQuery::Trusted(canonical) => {
            AllowedRoots::validate_canonical_zip_file(canonical)?;
            return Ok(true);
        }
        ShareQuery::Confirmed(canonical) => {
            state.register_canonical_file(AllowedRoots::validate_canonical_zip_file(canonical)?);
            return Ok(true);
        }
        ShareQuery::Local => {}
    }
    let archive = AllowedRoots::canonical_zip_file_path(&path)?;
    if state.is_allowed(&archive.to_string_lossy()) {
        return Ok(true);
    }
    let _dialog_guard = dialogs.try_acquire()?;
    let locale = crate::menu::resolve_locale(&app);
    let display_path = normalize_path_for_display(&archive);
    let (title, prompt) = archive_access_prompt(&locale, &display_path);

    let approved = app
        .dialog()
        .message(prompt)
        .title(title)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if approved {
        state.register_zip_file_if_unchanged(&path, &archive)?;
    }
    Ok(approved)
}

fn archive_access_prompt(locale: &str, display_path: &str) -> (&'static str, String) {
    if locale == "ja" {
        (
            "アーカイブへのアクセス確認",
            format!("次のアーカイブファイルへのアクセスを許可しますか？\n\n{display_path}"),
        )
    } else {
        (
            "Confirm archive access",
            format!("Allow access to this archive file?\n\n{display_path}"),
        )
    }
}

/// Explorerルート用の認可。承認済みのディレクトリを唯一の永続信頼へ置換する。
#[tauri::command]
pub async fn authorize_folder_path(
    app: AppHandle,
    path: String,
    state: State<'_, AllowedRoots>,
    persistent: State<'_, PersistentExplorerRoot>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<bool, String> {
    let (share, _share_guard) =
        query_share_authorization(&state, &app, &dialogs, &path, ShareGrant::Folder)?;
    let (share_path, confirmed) = match share {
        ShareQuery::Declined => return Ok(false),
        ShareQuery::Local => (None, false),
        ShareQuery::Trusted(canonical) => (Some(canonical), false),
        ShareQuery::Confirmed(canonical) => (Some(canonical), true),
    };
    let requested = Path::new(&path);
    let root = ExplorerRoot::inspect(requested)?;
    if share_path
        .as_deref()
        .is_some_and(|path| path != root.path())
    {
        return Err("確認した共有パスとフォルダーの参照先が一致しません".to_string());
    }
    if persistent.matches(&root) {
        return Ok(true);
    }

    if confirmed {
        persist_explorer_root(&app, &state, &persistent, root)?;
        return Ok(true);
    }

    let _dialog_guard = dialogs.try_acquire()?;
    let locale = crate::menu::resolve_locale(&app);
    let display_root = normalize_path_for_display(root.path());
    let (title, prompt) = if locale == "ja" {
        (
            "フォルダーへのアクセス確認",
            format!(
                "次のフォルダー内のファイルへのアクセスを許可しますか？\n\n{}",
                display_root
            ),
        )
    } else {
        (
            "Confirm folder access",
            format!("Allow access to files in this folder?\n\n{}", display_root),
        )
    };
    let approved = app
        .dialog()
        .message(prompt)
        .title(title)
        .buttons(MessageDialogButtons::YesNo)
        .blocking_show();
    if approved {
        if ExplorerRoot::inspect(requested)? != root {
            return Err("確認中にフォルダーの参照先が変更されました".to_string());
        }
        persist_explorer_root(&app, &state, &persistent, root)?;
    }
    Ok(approved)
}

#[tauri::command]
pub async fn pick_markdown_file(
    app: AppHandle,
    state: State<'_, AllowedRoots>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<Option<String>, String> {
    let _dialog_guard = dialogs.try_acquire()?;
    let selected = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("選択したパスを解決できません: {}", e))?;
    if !has_markdown_extension(&path) {
        return Err("Markdownファイル（.md / .markdown）を選択してください".to_string());
    }
    state.register(&path.to_string_lossy())?;
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

#[cfg(test)]
mod tests {
    use super::archive_access_prompt;

    #[test]
    fn archive_prompt_names_the_archive_and_shows_its_full_path() {
        let (title, prompt) = archive_access_prompt("ja", "D:/archives/notes.zip");
        assert_eq!(title, "アーカイブへのアクセス確認");
        assert!(prompt.contains("アーカイブファイル"));
        assert!(prompt.contains("D:/archives/notes.zip"));

        let (title, prompt) = archive_access_prompt("en", "/home/alice/notes.zip");
        assert_eq!(title, "Confirm archive access");
        assert!(prompt.contains("/home/alice/notes.zip"));
    }
}

#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    state: State<'_, AllowedRoots>,
    persistent: State<'_, PersistentExplorerRoot>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<Option<String>, String> {
    let _dialog_guard = dialogs.try_acquire()?;
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("選択したパスを解決できません: {}", e))?;
    let root = ExplorerRoot::inspect(&path)?;
    persist_explorer_root(&app, &state, &persistent, root)?;
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

#[tauri::command]
pub async fn pick_zip_file(
    app: AppHandle,
    state: State<'_, AllowedRoots>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<Option<String>, String> {
    let _dialog_guard = dialogs.try_acquire()?;
    let selected = app
        .dialog()
        .file()
        .add_filter("ZIP archive", &["zip"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("選択したパスを解決できません: {error}"))?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("ZIPファイル（.zip）を選択してください".to_string());
    }
    state.register_zip_file(&path.to_string_lossy())?;
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}

#[tauri::command]
pub async fn pick_custom_css(
    app: AppHandle,
    state: State<'_, AllowedRoots>,
    dialogs: State<'_, NativeDialogState>,
) -> Result<Option<String>, String> {
    let _dialog_guard = dialogs.try_acquire()?;
    let selected = app
        .dialog()
        .file()
        .add_filter("CSS", &["css"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|e| format!("選択したパスを解決できません: {}", e))?;
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("css"))
    {
        return Err("CSSファイル（.css）を選択してください".to_string());
    }
    state.register(&path.to_string_lossy())?;
    Ok(Some(path.to_string_lossy().replace('\\', "/")))
}
