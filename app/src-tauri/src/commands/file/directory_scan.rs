use super::ignore_rules::{open_rule_path, WalkRules};
use super::persistent_trust::{directory_identity, DirectoryIdentity};
#[cfg(unix)]
use super::trusted_paths::open_path_without_links;
use super::trusted_paths::{final_path_for_file, AllowedRoots};
use crate::commands::has_markdown_extension;
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::path::{Component, Path, PathBuf};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
use super::windows_open::{open_relative_direct, open_scan_directory};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use unix::{open_relative_direct, DirectoryReader};
#[cfg(windows)]
use windows::DirectoryReader;

#[cfg(windows)]
const MAX_OPEN_DIRECTORIES: usize = 256;
#[cfg(unix)]
const MAX_OPEN_DIRECTORIES: usize = 32;
#[cfg(unix)]
static DIRECTORY_SCAN: std::sync::Mutex<()> = std::sync::Mutex::new(());
const ROOT_CHANGED: &str = "文書ソースのフォルダーが変更されました";

#[cfg(windows)]
type DirectoryHandle<'a> = &'a File;
#[cfg(unix)]
type DirectoryHandle<'a> = std::os::fd::BorrowedFd<'a>;

#[derive(Clone, Debug)]
pub(crate) struct RegisteredDirectory {
    identity: DirectoryIdentity,
}

impl RegisteredDirectory {
    pub(crate) fn capture(path: &Path, roots: &AllowedRoots) -> Result<Self, String> {
        let file = open_scan_root(path, roots, false)?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        let identity =
            directory_identity(&file, &metadata).ok_or("文書ソースのフォルダーを識別できません")?;
        Ok(Self { identity })
    }

    pub(crate) fn same_as(&self, other: &Self) -> bool {
        self.identity == other.identity
    }

    pub(crate) fn verify_current(&self, path: &Path, roots: &AllowedRoots) -> Result<(), String> {
        self.verify(path, roots, false).map(drop)
    }

    pub(crate) fn open_verified<'a>(
        &'a self,
        path: &'a Path,
        roots: &'a AllowedRoots,
    ) -> Result<VerifiedDirectory<'a>, String> {
        // Bound the combined number of Unix directory descriptors across scans.
        // Take the slot before opening a handle so waiting scans hold no descriptors.
        #[cfg(unix)]
        let slot = DIRECTORY_SCAN
            .lock()
            .map_err(|_| "文書の走査を開始できません")?;
        let handle = self.verify(path, roots, true)?;
        Ok(VerifiedDirectory {
            registered: self,
            path,
            roots,
            handle,
            #[cfg(unix)]
            _slot: slot,
        })
    }

    fn verify(
        &self,
        path: &Path,
        roots: &AllowedRoots,
        list_entries: bool,
    ) -> Result<File, String> {
        let file = open_scan_root(path, roots, list_entries)?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if directory_identity(&file, &metadata).as_ref() != Some(&self.identity) {
            return Err(ROOT_CHANGED.into());
        }
        Ok(file)
    }
}

fn open_scan_root(path: &Path, roots: &AllowedRoots, list_entries: bool) -> Result<File, String> {
    roots.resolve_opened_path(path.to_owned())?;
    let requested = roots.share_checked_input(path.to_str().ok_or("無効なソースパスです")?)?;
    #[cfg(windows)]
    let file = open_scan_directory(&requested, list_entries);
    #[cfg(unix)]
    let file = {
        let _ = list_entries;
        open_path_without_links(&requested, true)
    };
    let file = file.map_err(|error| format!("{ROOT_CHANGED}: {error}"))?;
    if !file.metadata().is_ok_and(|metadata| metadata.is_dir())
        || final_path_for_file(&file)? != path
    {
        return Err(ROOT_CHANGED.into());
    }
    roots.resolve_opened_path(path.to_owned())?;
    Ok(file)
}

struct DirectoryEntry {
    name: OsString,
    kind: EntryKind,
    hidden: bool,
}

impl DirectoryEntry {
    fn path_component(&self) -> Option<&Path> {
        let name = Path::new(&self.name);
        let mut components = name.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(part)), None) if part == self.name => Some(name),
            _ => None,
        }
    }
}

/// Enumerates a bounded, already opened directory without reopening its path.
pub(crate) fn read_directory_names(handle: File, limit: usize) -> io::Result<Vec<OsString>> {
    let mut directory = DirectoryReader::new(handle)?;
    let mut names = Vec::new();
    while let Some(entry) = directory.next_entry()? {
        if entry.path_component().is_some() {
            if names.len() == limit {
                return Err(io::Error::other("Directory entry limit exceeded"));
            }
            names.push(entry.name);
        }
    }
    Ok(names)
}

/// Opens a relative path from a live directory without traversing links.
pub(crate) fn open_directory_child(
    directory: &File,
    relative: &Path,
    access: ChildAccess,
) -> io::Result<File> {
    #[cfg(unix)]
    let directory = std::os::fd::AsFd::as_fd(directory);
    open_below(directory, relative, access)
}

#[derive(Clone, Copy)]
pub(crate) enum ChildAccess {
    Read,
    Traverse,
    List,
}

enum EntryKind {
    Directory,
    File,
    Other,
}

#[derive(Clone, Copy)]
pub(crate) enum SubdirectoryErrors {
    Report,
    Skip,
}

fn open_below(
    directory: DirectoryHandle<'_>,
    relative: &Path,
    access: ChildAccess,
) -> io::Result<File> {
    let mut normalized = PathBuf::new();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        #[cfg(windows)]
        if name
            .as_encoded_bytes()
            .iter()
            .any(|unit| matches!(unit, b':' | b'/' | b'\\' | 0))
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        normalized.push(name);
    }
    if normalized.as_os_str().is_empty() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    open_relative_direct(directory, &normalized, access)
}

pub(crate) struct VerifiedDirectory<'a> {
    registered: &'a RegisteredDirectory,
    path: &'a Path,
    roots: &'a AllowedRoots,
    handle: File,
    #[cfg(unix)]
    _slot: std::sync::MutexGuard<'static, ()>,
}

impl VerifiedDirectory<'_> {
    pub(crate) fn markdown_paths(
        self,
        show_hidden: bool,
        respect_gitignore: bool,
        limit: usize,
        subdirectory_errors: SubdirectoryErrors,
    ) -> Result<(Vec<PathBuf>, bool), String> {
        let paths = scan(
            self.path,
            self.handle,
            self.roots,
            show_hidden,
            respect_gitignore,
            limit,
            subdirectory_errors,
        )
        .map_err(|error| format!("Markdown一覧の走査に失敗しました: {error}"))?;
        self.registered.verify_current(self.path, self.roots)?;
        Ok(paths)
    }
}

fn scan(
    root_path: &Path,
    root: File,
    roots: &AllowedRoots,
    show_hidden: bool,
    respect_gitignore: bool,
    limit: usize,
    subdirectory_errors: SubdirectoryErrors,
) -> io::Result<(Vec<PathBuf>, bool)> {
    let root = DirectoryReader::new(root)?;
    let mut pending = vec![(PathBuf::new(), root)];
    let mut rules = respect_gitignore.then(WalkRules::new);
    let mut paths = Vec::new();
    let mut visited = 1; // The previous walker counted the source root.
    let mut truncated = false;

    while let Some((relative, directory)) = pending.last_mut() {
        let entry = match directory.next_entry() {
            Ok(Some(entry)) => entry,
            Ok(None) => {
                pending.pop();
                continue;
            }
            Err(_)
                if !relative.as_os_str().is_empty()
                    && matches!(subdirectory_errors, SubdirectoryErrors::Skip) =>
            {
                truncated = true;
                pending.pop();
                continue;
            }
            Err(error) => return Err(error),
        };
        let Some(name) = entry.path_component() else {
            continue;
        };
        let (relative, directory) = pending.last().unwrap();
        let path = relative.join(name);
        let is_dir = matches!(entry.kind, EntryKind::Directory);
        let hidden = entry.hidden || entry.name.as_encoded_bytes().starts_with(b".");
        let root_handle = pending[0].1.handle();
        let included = match &mut rules {
            Some(rules) => rules.includes(
                &root_path.join(&path),
                is_dir,
                hidden,
                show_hidden,
                |dir| {
                    dir.starts_with(root_path) || roots.resolve_opened_path(dir.to_owned()).is_ok()
                },
                |rule| match rule.strip_prefix(root_path) {
                    Ok(relative) => open_below(root_handle, relative, ChildAccess::Read).ok(),
                    Err(_) => open_rule_path(roots, rule),
                },
            ),
            None => show_hidden || !hidden,
        };
        if !included {
            continue;
        }
        if visited >= limit {
            return Ok((paths, true));
        }
        visited += 1;
        match entry.kind {
            EntryKind::Directory => {
                if pending.len() >= MAX_OPEN_DIRECTORIES {
                    truncated = true;
                    continue;
                }
                match open_below(directory.handle(), name, ChildAccess::List)
                    .and_then(DirectoryReader::new)
                {
                    Ok(child) => pending.push((path, child)),
                    Err(error)
                        if error.kind() == io::ErrorKind::NotFound
                            || matches!(subdirectory_errors, SubdirectoryErrors::Skip) =>
                    {
                        truncated = true;
                    }
                    Err(error) => return Err(error),
                }
            }
            EntryKind::File if has_markdown_extension(&path) => paths.push(path),
            _ => {}
        }
    }
    Ok((paths, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn enumeration_keeps_using_the_verified_directory_after_its_path_changes() {
        let temp = tempfile::tempdir().unwrap();
        let location = temp.path().join("notes");
        fs::create_dir_all(location.join("child")).unwrap();
        fs::create_dir_all(location.join(".git/info")).unwrap();
        fs::write(location.join(".git/info/exclude"), "skipped.md\n").unwrap();
        fs::write(location.join("child/original.md"), "# Original").unwrap();
        fs::write(location.join("child/skipped.md"), "# Excluded").unwrap();
        let roots = AllowedRoots::new();
        roots.register(&location.to_string_lossy()).unwrap();
        let root = roots.resolve(&location.to_string_lossy()).unwrap();
        let directory = RegisteredDirectory::capture(&root, &roots).unwrap();
        let verified = directory.open_verified(&root, &roots).unwrap();

        fs::rename(&location, temp.path().join("previous")).unwrap();
        fs::create_dir_all(location.join("child")).unwrap();
        fs::write(location.join(".ignore"), "original.md\n").unwrap();
        fs::write(location.join("child/replacement.md"), "# Replacement").unwrap();

        let (paths, truncated) = scan(
            &root,
            verified.handle,
            &roots,
            true,
            true,
            100,
            SubdirectoryErrors::Report,
        )
        .unwrap();
        assert_eq!(paths, [PathBuf::from("child").join("original.md")]);
        assert!(!truncated);
        assert!(directory.verify(&root, &roots, false).is_err());
    }

    #[test]
    fn the_directory_depth_limit_is_reported_as_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let roots = AllowedRoots::new();
        roots.register(&temp.path().to_string_lossy()).unwrap();
        let root = roots.resolve(&temp.path().to_string_lossy()).unwrap();
        fs::write(root.join("visible.md"), "# Visible").unwrap();
        let mut deep = root.clone();
        for _ in 0..MAX_OPEN_DIRECTORIES {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("deep.md"), "# Deep").unwrap();

        let (paths, truncated) = RegisteredDirectory::capture(&root, &roots)
            .unwrap()
            .open_verified(&root, &roots)
            .unwrap()
            .markdown_paths(
                true,
                false,
                2 * MAX_OPEN_DIRECTORIES,
                SubdirectoryErrors::Report,
            )
            .unwrap();
        assert_eq!(paths, [PathBuf::from("visible.md")]);
        assert!(truncated);
    }
}
