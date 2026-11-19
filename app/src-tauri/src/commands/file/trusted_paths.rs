use super::windows_share::WindowsSharePath;
use crate::commands::has_markdown_extension;
use std::borrow::Cow;
use std::collections::HashSet;
use std::fs::{File, Metadata};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

pub const MAX_INPUT_PATHS: usize = 32;

pub(super) enum ShareQuery {
    Local,
    Declined,
    Trusted(PathBuf),
    Confirmed(PathBuf),
}

fn canonicalize_path(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let handle = super::windows_open::open(path, false)
            .map_err(|error| format!("パスの解決に失敗しました: {error}"))?;
        final_path_for_file(&handle)
    }
    #[cfg(not(windows))]
    {
        std::fs::canonicalize(path).map_err(|error| format!("パスの解決に失敗しました: {error}"))
    }
}

pub(super) fn inspect_path(path: &Path) -> Result<Option<(PathBuf, Metadata)>, String> {
    #[cfg(windows)]
    let opened = super::windows_open::open(path, false);
    #[cfg(windows)]
    let result = match opened {
        Ok(handle) => {
            let canonical = final_path_for_file(&handle)?;
            handle.metadata().map(|metadata| (canonical, metadata))
        }
        Err(error) => Err(error),
    };
    #[cfg(not(windows))]
    let result = std::fs::canonicalize(path)
        .and_then(|canonical| std::fs::metadata(&canonical).map(|metadata| (canonical, metadata)));
    match result {
        Ok(found) => Ok(Some(found)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("パスを確認できませんでした: {error}")),
    }
}

/// ユーザーが明示的に許可したフォルダールートと単一ファイルの集合。
/// 全ファイルアクセスはルート配下、または単一ファイルとの完全一致に限定される。
/// 信頼起点をフロントエンド（WebView）ではなくRust側に置くことで、
/// 万一WebView側でスクリプトが実行されても任意ファイル読み取りを防ぐ。
#[derive(Default)]
pub(super) struct AllowedEntries {
    pub(super) roots: Vec<PathBuf>,
    pub(super) files: HashSet<PathBuf>,
}

#[derive(Default, Clone)]
pub struct AllowedRoots(pub(super) Arc<Mutex<AllowedEntries>>);

impl AllowedRoots {
    pub fn new() -> Self {
        Self::default()
    }

    /// pathを信頼済みルートとして登録する。pathがファイルの場合はその親フォルダを登録する。
    /// 危険なフォルダ（ドライブ直下・システムフォルダ・ユーザープロファイル直下）は拒否する。
    pub(super) fn root_for_path(path: &str) -> Result<PathBuf, String> {
        Self::root_for_canonical_path(canonicalize_path(Path::new(path))?)
    }

    pub(super) fn root_for_canonical_path(canonical: PathBuf) -> Result<PathBuf, String> {
        let root = if inspect_path(&canonical)?.is_some_and(|(_, metadata)| metadata.is_dir()) {
            canonical
        } else {
            canonical
                .parent()
                .ok_or_else(|| "親フォルダーを特定できません".to_string())?
                .to_path_buf()
        };

        if let Some(reason) = dangerous_root_reason(&root) {
            return Err(reason.to_string());
        }

        Ok(root)
    }

    pub(crate) fn register(&self, path: &str) -> Result<(), String> {
        let root = Self::root_for_path(path)?;

        self.register_root_path(root);
        Ok(())
    }

    pub(super) fn register_root_path(&self, root: PathBuf) {
        let mut entries = self.0.lock().unwrap();
        if !entries.roots.iter().any(|registered| registered == &root) {
            entries.roots.push(root);
        }
    }

    pub(super) fn canonical_zip_file_path(path: &str) -> Result<PathBuf, String> {
        Self::validate_canonical_zip_file(canonicalize_path(Path::new(path))?)
    }

    pub(super) fn validate_canonical_zip_file(canonical: PathBuf) -> Result<PathBuf, String> {
        if !inspect_path(&canonical)?.is_some_and(|(_, metadata)| metadata.is_file()) {
            return Err("ファイルを指定してください".to_string());
        }
        if !canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            return Err("ZIPファイル（.zip）を指定してください".to_string());
        }
        Ok(canonical)
    }

    /// ZIP単体だけを信頼対象として登録する。canonicalize後の実体もZIPでなければ拒否する。
    pub(crate) fn register_zip_file(&self, path: &str) -> Result<(), String> {
        let canonical = Self::canonical_zip_file_path(path)?;
        self.register_canonical_file(canonical);
        Ok(())
    }

    /// 確認画面を表示した時点と承認後で、選択パスの実体が変わっていない場合だけ登録する。
    pub(super) fn register_zip_file_if_unchanged(
        &self,
        path: &str,
        expected: &Path,
    ) -> Result<(), String> {
        let current = Self::canonical_zip_file_path(path)?;
        if current != expected {
            return Err("確認中にアーカイブファイルの参照先が変更されました".to_string());
        }
        self.register_canonical_file(current);
        Ok(())
    }

    pub(super) fn register_canonical_file(&self, canonical: PathBuf) {
        self.0.lock().unwrap().files.insert(canonical);
    }

    fn share_path_is_trusted(&self, candidate: &WindowsSharePath) -> bool {
        let entries = self.0.lock().unwrap();
        if entries
            .files
            .iter()
            .any(|file| candidate.matches_path(file))
        {
            return true;
        }
        entries.roots.iter().any(|root| {
            root.to_str()
                .and_then(|path| WindowsSharePath::from_input(path).ok().flatten())
                .is_some_and(|root| root.contains(candidate))
        })
    }

    pub(super) fn query_share(
        &self,
        path: &str,
        confirm: impl FnOnce(&Path) -> Result<bool, String>,
    ) -> Result<ShareQuery, String> {
        self.query_share_with(path, confirm, canonicalize_path)
    }

    fn query_share_with(
        &self,
        path: &str,
        confirm: impl FnOnce(&Path) -> Result<bool, String>,
        canonicalize: impl FnOnce(&Path) -> Result<PathBuf, String>,
    ) -> Result<ShareQuery, String> {
        let Some(share) = WindowsSharePath::from_input(path)? else {
            return Ok(ShareQuery::Local);
        };
        let requested = share.as_path();
        if self.share_path_is_trusted(&share) {
            return self
                .resolve_opened_path(canonicalize(&requested)?)
                .map(ShareQuery::Trusted);
        }
        if !confirm(&requested)? {
            return Ok(ShareQuery::Declined);
        }
        let canonical = canonicalize(&requested)?;
        if !share.matches_path(&canonical) {
            return Err("共有パスの解決先が確認したパスと一致しません".into());
        }
        Ok(ShareQuery::Confirmed(canonical))
    }

    /// pathをcanonicalizeし、信頼済みルートのいずれかの配下にあることを検証する。
    /// シンボリックリンクは解決済みのパスで判定するため、リンク経由の脱出も防ぐ。
    pub(crate) fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        self.resolve_with(path, canonicalize_path)
    }

    fn resolve_with(
        &self,
        path: &str,
        canonicalize: impl FnOnce(&Path) -> Result<PathBuf, String>,
    ) -> Result<PathBuf, String> {
        let input = self.share_checked_input(path)?;
        self.resolve_opened_path(canonicalize(&input)?)
    }

    fn share_checked_input<'a>(&self, path: &'a str) -> Result<Cow<'a, Path>, String> {
        Ok(match WindowsSharePath::from_input(path)? {
            Some(share) if self.share_path_is_trusted(&share) => Cow::Owned(share.as_path()),
            Some(_) => return Err("共有パスへのアクセスが許可されていません".into()),
            None => Cow::Borrowed(Path::new(path)),
        })
    }

    /// Apply the share gate before probing. Callers must check the returned path's
    /// trust and source boundaries before using the result.
    pub(crate) fn inspect_share_checked_path(
        &self,
        path: &str,
    ) -> Result<Option<(PathBuf, Metadata)>, String> {
        inspect_path(&self.share_checked_input(path)?)
    }

    pub(crate) fn inspect_allowed_path(
        &self,
        path: &str,
    ) -> Result<Option<(PathBuf, Metadata)>, String> {
        self.inspect_share_checked_path(path)?
            .map(|(canonical, metadata)| {
                self.resolve_opened_path(canonical)
                    .map(|path| (path, metadata))
            })
            .transpose()
    }

    pub(crate) fn resolve_opened_path(&self, canonical: PathBuf) -> Result<PathBuf, String> {
        let entries = self.0.lock().unwrap();
        if entries.files.contains(&canonical)
            || entries.roots.iter().any(|root| canonical.starts_with(root))
        {
            Ok(canonical)
        } else {
            Err("許可されていないファイルです".to_string())
        }
    }

    pub(super) fn is_allowed(&self, path: &str) -> bool {
        self.resolve(path).is_ok()
    }

    pub(crate) fn register_input_paths(&self, paths: &[PathBuf]) {
        let mut folder_registered = false;
        for path in paths.iter().take(MAX_INPUT_PATHS) {
            let Ok(Some((_, metadata))) = inspect_path(path) else {
                continue;
            };
            if metadata.is_dir() && !folder_registered {
                folder_registered = self.register(&path.to_string_lossy()).is_ok();
            } else if metadata.is_file() {
                let is_zip = path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
                if has_markdown_extension(path) || is_zip {
                    let result = if is_zip {
                        self.register_zip_file(&path.to_string_lossy())
                    } else {
                        self.register(&path.to_string_lossy())
                    };
                    let _ = result;
                }
            }
        }
    }
}

/// 信頼済みルートとして登録すべきでない危険なフォルダかを判定する。
/// Windowsを主対象とし、canonicalize後のパス（verbatimプレフィックス付き）でも
/// 正しく判定できるよう、Normalコンポーネントだけを取り出して評価する。
pub(super) fn dangerous_root_reason(path: &Path) -> Option<&'static str> {
    let normals: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();

    // ドライブ直下 / ファイルシステムルート直下（例: C:\ , / ）
    if normals.is_empty() {
        return Some("ドライブ直下は信頼フォルダーに指定できません");
    }

    // Windowsのシステムフォルダ（先頭コンポーネントで判定）
    if matches!(
        normals[0].as_str(),
        "windows" | "program files" | "program files (x86)" | "programdata"
    ) {
        return Some("システムフォルダーは信頼フォルダーに指定できません");
    }

    // ユーザープロファイル直下（例: C:\Users\<name>）。配下のDocuments等は許可する。
    if normals.len() == 2 && normals[0] == "users" {
        return Some("ユーザープロファイル直下は信頼フォルダーに指定できません");
    }

    None
}

/// CDPを使う開発時E2Eフック専用。リリースビルドでは信頼登録しない。
#[tauri::command]
pub fn authorize_dev_path(path: String, state: State<'_, AllowedRoots>) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let is_zip = Path::new(&path)
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"));
        if is_zip {
            state.register_zip_file(&path)
        } else {
            state.register(&path)
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (path, state);
        Err("開発ビルドでのみ利用できます".to_string())
    }
}

/// pathが信頼済みルートのいずれかの配下にあるかを判定する
#[tauri::command]
pub fn is_path_allowed(path: String, state: State<'_, AllowedRoots>) -> bool {
    state.is_allowed(&path)
}

pub(crate) fn open_allowed_file(
    state: &AllowedRoots,
    path: &str,
) -> Result<(File, PathBuf), String> {
    #[cfg(windows)]
    let file = super::windows_open::open(&state.share_checked_input(path)?, true)
        .map_err(|error| format!("パスの解決に失敗しました: {error}"))?;
    #[cfg(not(windows))]
    let file = File::open(state.resolve(path)?)
        .map_err(|error| format!("ファイル読み込みエラー: {error}"))?;
    let opened_path = final_path_for_file(&file)?;
    let verified = state.resolve_opened_path(opened_path)?;
    Ok((file, verified))
}

#[cfg(windows)]
pub(super) fn final_path_for_file(file: &File) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = file.as_raw_handle();
    let required = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
    if required == 0 {
        return Err(format!(
            "ファイル最終パスの取得に失敗しました: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut buffer = vec![0u16; required as usize + 1];
    let written =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if written == 0 || written as usize >= buffer.len() {
        return Err(format!(
            "ファイル最終パスの取得に失敗しました: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(std::ffi::OsString::from_wide(&buffer[..written as usize]).into())
}

#[cfg(target_os = "linux")]
pub(super) fn final_path_for_file(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    std::fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|e| format!("ファイル最終パスの取得に失敗しました: {}", e))
}

#[cfg(target_os = "macos")]
pub(super) fn final_path_for_file(file: &File) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    let mut buffer = vec![0i8; libc::PATH_MAX as usize];
    let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        return Err(format!(
            "ファイル最終パスの取得に失敗しました: {}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_bytes();
    Ok(std::ffi::OsStr::from_bytes(bytes).into())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(super) fn final_path_for_file(_file: &File) -> Result<PathBuf, String> {
    Err("このOSでは安全なファイル読込を利用できません".to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::cell::Cell;

    const SHARED_FILE: &str = r"\\fileserver\team\docs\notes.md";
    const CANONICAL_FILE: &str = r"\\?\UNC\fileserver\team\docs\notes.md";

    #[test]
    fn untrusted_share_is_not_queried_by_reads_or_after_declining() {
        let roots = AllowedRoots::new();
        for path in [
            SHARED_FILE,
            "//fileserver/team/docs/notes.md",
            CANONICAL_FILE,
        ] {
            assert!(roots
                .resolve_with(path, |_| panic!("untrusted share reached the filesystem"))
                .is_err());

            let prompted = Cell::new(false);
            let outcome = roots
                .query_share_with(
                    path,
                    |target| {
                        assert_eq!(target, Path::new(CANONICAL_FILE));
                        prompted.set(true);
                        Ok(false)
                    },
                    |_| panic!("declined share reached the filesystem"),
                )
                .unwrap();
            assert!(prompted.get());
            assert!(matches!(outcome, ShareQuery::Declined));
        }
    }

    #[test]
    fn approved_folder_queries_without_prompting_again() {
        let roots = AllowedRoots::new();
        let confirmed = Cell::new(false);
        let outcome = roots
            .query_share_with(
                SHARED_FILE,
                |_| {
                    confirmed.set(true);
                    Ok(true)
                },
                |target| {
                    assert!(confirmed.get());
                    Ok(target.to_path_buf())
                },
            )
            .unwrap();
        let ShareQuery::Confirmed(file) = outcome else {
            panic!("expected share consent");
        };
        roots.register_root_path(file.parent().unwrap().to_path_buf());

        let file = roots
            .resolve_with("//FILESERVER/team/docs/notes.md", |_| {
                Ok(PathBuf::from(CANONICAL_FILE))
            })
            .unwrap();
        assert_eq!(file, Path::new(CANONICAL_FILE));
        assert!(matches!(
            roots
                .query_share_with(
                    SHARED_FILE,
                    |_| panic!("approved share prompted again"),
                    |target| Ok(target.to_path_buf())
                )
                .unwrap(),
            ShareQuery::Trusted(_)
        ));
        for path in [
            "//fileserver/team/docs-archive/notes.md",
            "//fileserver/team/docs/../other/notes.md",
            "//fileserver/team/DOCS/notes.md",
            "//fileserver/other/docs/notes.md",
        ] {
            assert!(roots
                .resolve_with(path, |_| panic!("share path outside the approved folder"))
                .is_err());
        }
    }

    #[test]
    fn share_consent_only_grants_the_address_shown() {
        let roots = AllowedRoots::new();
        assert!(roots
            .query_share_with(
                SHARED_FILE,
                |_| Ok(true),
                |_| Ok(PathBuf::from(r"\\?\UNC\fileserver\other\docs\notes.md"))
            )
            .is_err());
    }

    #[test]
    fn a_trusted_archive_does_not_preapprove_its_folder_or_siblings() {
        let roots = AllowedRoots::new();
        let archive = PathBuf::from(r"\\?\UNC\fileserver\team\docs\notes.zip");
        roots.register_canonical_file(archive.clone());
        assert_eq!(
            roots
                .resolve_with("//fileserver/team/docs/notes.zip", |path| Ok(
                    path.to_path_buf()
                ))
                .unwrap(),
            archive
        );
        assert!(roots
            .resolve_with(SHARED_FILE, |_| panic!(
                "archive trust escaped to a sibling"
            ))
            .is_err());
        assert!(roots
            .resolve_with("//fileserver/team/docs/NOTES.ZIP", |_| {
                panic!("a differently cased archive may be a separate file")
            })
            .is_err());
    }

    #[test]
    fn local_path_uses_existing_resolution() {
        let roots = AllowedRoots::new();
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("notes.md");
        std::fs::write(&file, "local Markdown").unwrap();
        roots.register(&file.to_string_lossy()).unwrap();
        assert_eq!(
            roots.resolve(&file.to_string_lossy()).unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert!(matches!(
            roots
                .query_share_with(
                    &file.to_string_lossy(),
                    |_| panic!("local path used the share prompt"),
                    |_| panic!("local path used the share resolver")
                )
                .unwrap(),
            ShareQuery::Local
        ));
    }
}
