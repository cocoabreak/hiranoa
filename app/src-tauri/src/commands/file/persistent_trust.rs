use super::trusted_paths::{dangerous_root_reason, final_path_for_file, AllowedRoots};
use crate::commands::app_state::state_store_path;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, Metadata};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Wry};
use tauri_plugin_store::{Store, StoreExt};

const TRUST_STORE_FILE: &str = "trusted-root.json";
const TRUST_STORE_KEY: &str = "root";
const APPROVAL_VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum DirectoryIdentity {
    #[cfg(windows)]
    Windows {
        volume: u64,
        file_id: [u8; 16],
        creation_time: u64,
    },
    #[cfg(unix)]
    Unix {
        device: u64,
        inode: u64,
        created: (u64, u32),
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ExplorerRoot {
    version: u8,
    path: PathBuf,
    identity: Option<DirectoryIdentity>,
}

impl ExplorerRoot {
    pub(super) fn inspect(path: &Path) -> Result<Self, String> {
        let handle =
            open_folder(path).map_err(|error| format!("フォルダーを開けません: {error}"))?;
        let metadata = handle.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err("フォルダーを指定してください".to_string());
        }
        let path = final_path_for_file(&handle)?;
        if let Some(reason) = dangerous_root_reason(&path) {
            return Err(reason.to_string());
        }
        Ok(Self {
            version: APPROVAL_VERSION,
            path,
            identity: directory_identity(&handle, &metadata),
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn still_matches(&self) -> bool {
        Self::inspect(&self.path).is_ok_and(|current| current == *self)
    }
}

#[cfg(windows)]
fn open_folder(path: &Path) -> std::io::Result<File> {
    super::windows_open::open(path, false)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_folder(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY)
        .open(path)
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn open_folder(_path: &Path) -> std::io::Result<File> {
    Err(std::io::ErrorKind::Unsupported.into())
}

#[cfg(windows)]
fn directory_identity(handle: &File, metadata: &Metadata) -> Option<DirectoryIdentity> {
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut info = FILE_ID_INFO::default();
    // SAFETY: The live file handle and a writable FILE_ID_INFO buffer match FileIdInfo.
    let success = unsafe {
        GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    let file_id = info.FileId.Identifier;
    let creation_time = metadata.creation_time();
    if success == 0 || file_id == [0; 16] || creation_time == 0 {
        return None;
    }
    Some(DirectoryIdentity::Windows {
        volume: info.VolumeSerialNumber,
        file_id,
        creation_time,
    })
}

#[cfg(unix)]
fn directory_identity(_handle: &File, metadata: &Metadata) -> Option<DirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;

    // Inodes can be reused after deletion. Without a creation time, keep the
    // approval in memory only instead of assuming an inode is still the same.
    let created = metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(DirectoryIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
        created: (created.as_secs(), created.subsec_nanos()),
    })
}

#[cfg(not(any(windows, unix)))]
fn directory_identity(_handle: &File, _metadata: &Metadata) -> Option<DirectoryIdentity> {
    None
}

#[derive(Default)]
pub struct PersistentExplorerRoot(Mutex<Option<ExplorerRoot>>);

impl PersistentExplorerRoot {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) fn matches(&self, root: &ExplorerRoot) -> bool {
        self.0.lock().unwrap().as_ref() == Some(root)
    }

    fn register(&self, roots: &AllowedRoots, root: ExplorerRoot) {
        roots.register_explorer_root(root.clone());
        *self.0.lock().unwrap() = Some(root);
    }
}

fn explorer_root_store(app: &AppHandle) -> Result<Arc<Store<Wry>>, String> {
    app.store_builder(state_store_path(TRUST_STORE_FILE))
        .disable_auto_save()
        .build()
        .map_err(|error| error.to_string())
}

pub(super) fn persist_explorer_root(
    app: &AppHandle,
    roots: &AllowedRoots,
    persistent: &PersistentExplorerRoot,
    root: ExplorerRoot,
) -> Result<(), String> {
    let store = explorer_root_store(app)?;
    let previous = store.get(TRUST_STORE_KEY);
    if root.identity.is_some() {
        store.set(
            TRUST_STORE_KEY,
            serde_json::to_value(&root).map_err(|error| error.to_string())?,
        );
    } else {
        // A folder without a stable identity can still be authorized for this session.
        store.delete(TRUST_STORE_KEY);
    }
    if let Err(error) = store.save() {
        match previous {
            Some(value) => store.set(TRUST_STORE_KEY, value),
            None => {
                store.delete(TRUST_STORE_KEY);
            }
        }
        return Err(error.to_string());
    }
    persistent.register(roots, root);
    Ok(())
}

fn restore_approval(
    value: Value,
    roots: &AllowedRoots,
    persistent: &PersistentExplorerRoot,
    inspect: impl FnOnce(&Path) -> Result<ExplorerRoot, String>,
) {
    // A legacy string records a path only. Leave it untrusted until the normal
    // Explorer open flow gets fresh approval, without performing any lookup here.
    let Ok(saved) = serde_json::from_value::<ExplorerRoot>(value) else {
        return;
    };
    if saved.version != APPROVAL_VERSION
        || saved.identity.is_none()
        || !saved.path.is_absolute()
        || dangerous_root_reason(&saved.path).is_some()
    {
        return;
    }
    if inspect(&saved.path).is_ok_and(|current| current == saved) {
        persistent.register(roots, saved);
    }
}

pub(crate) fn restore_persisted_explorer_root(
    app: &AppHandle,
    roots: &AllowedRoots,
    persistent: &PersistentExplorerRoot,
) -> Result<(), String> {
    let store = explorer_root_store(app)?;
    if let Some(value) = store.get(TRUST_STORE_KEY) {
        restore_approval(value, roots, persistent, ExplorerRoot::inspect);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_the_same_directory_after_its_contents_change() {
        let dir = tempfile::tempdir().unwrap();
        let saved = ExplorerRoot::inspect(dir.path()).unwrap();
        if saved.identity.is_none() {
            return;
        }
        let value = serde_json::to_value(&saved).unwrap();
        let note = dir.path().join("note.md");
        std::fs::write(&note, "new contents").unwrap();

        let roots = AllowedRoots::new();
        let persistent = PersistentExplorerRoot::new();
        restore_approval(value, &roots, &persistent, ExplorerRoot::inspect);

        assert!(persistent.matches(&saved));
        assert!(roots.resolve(&note.to_string_lossy()).is_ok());
    }

    #[test]
    fn a_different_directory_at_the_saved_path_requires_fresh_approval() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes");
        std::fs::create_dir(&path).unwrap();
        let saved = ExplorerRoot::inspect(&path).unwrap();
        if saved.identity.is_none() {
            return;
        }
        let value = serde_json::to_value(&saved).unwrap();
        let active_roots = AllowedRoots::new();
        restore_approval(
            value.clone(),
            &active_roots,
            &PersistentExplorerRoot::new(),
            ExplorerRoot::inspect,
        );
        assert!(active_roots.resolve(&path.to_string_lossy()).is_ok());
        std::fs::rename(&path, dir.path().join("old-notes")).unwrap();
        std::fs::create_dir(&path).unwrap();
        let current = ExplorerRoot::inspect(&path).unwrap();
        assert_eq!(saved.path, current.path);
        assert_ne!(saved.identity, current.identity);

        let roots = AllowedRoots::new();
        let persistent = PersistentExplorerRoot::new();
        restore_approval(value, &roots, &persistent, ExplorerRoot::inspect);

        assert!(!persistent.matches(&current));
        assert!(roots.resolve(&path.to_string_lossy()).is_err());
        assert!(active_roots.resolve(&path.to_string_lossy()).is_err());
    }

    #[test]
    fn path_only_legacy_approval_never_triggers_an_automatic_lookup_or_grant() {
        let dir = tempfile::tempdir().unwrap();
        let current = ExplorerRoot::inspect(dir.path()).unwrap();
        let legacy = Value::String(current.path.to_string_lossy().into_owned());
        let roots = AllowedRoots::new();
        let persistent = PersistentExplorerRoot::new();

        restore_approval(legacy, &roots, &persistent, |_| {
            panic!("a legacy path must not be inspected during startup")
        });

        assert!(!persistent.matches(&current));
        assert!(roots.resolve(&dir.path().to_string_lossy()).is_err());
    }

    #[test]
    fn a_root_without_an_identity_cannot_be_restored() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = ExplorerRoot::inspect(dir.path()).unwrap();
        saved.identity = None;
        let value = serde_json::to_value(&saved).unwrap();
        let roots = AllowedRoots::new();
        let persistent = PersistentExplorerRoot::new();

        restore_approval(value, &roots, &persistent, |_| {
            panic!("a missing identity must fail before lookup")
        });

        assert!(roots.resolve(&dir.path().to_string_lossy()).is_err());
    }
}
