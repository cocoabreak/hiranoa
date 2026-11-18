use super::file::{
    mime_from_extension, trusted_paths::open_allowed_file, AllowedRoots, NativeDialogState,
};
use super::sources::{DocumentRef, SourceRegistry};
use base64::{engine::general_purpose::STANDARD, Engine};
use git2::{ObjectType, Odb, Oid, Repository};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_ASSETS: usize = 32 * 1024 * 1024;
const MAX_HISTORY: usize = 100;
const MAX_WALK: usize = 5000;
const MAX_OBJECT_METADATA: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommit {
    id: String,
    summary: String,
    author: String,
    timestamp: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInfo {
    session_id: String,
    path: String,
    commits: Vec<HistoryCommit>,
    truncated: bool,
}
#[derive(Serialize)]
pub struct HistorySnapshot {
    pub raw: String,
    pub present: bool,
}

struct HistorySession {
    id: String,
    file: PathBuf,
    root: PathBuf,
    git_dir: PathBuf,
    relative: PathBuf,
    commits: HashSet<String>,
    assets: HashMap<String, (String, usize)>,
    asset_bytes: usize,
}
#[derive(Default)]
struct HistoryInner {
    next_id: u64,
    session: Option<HistorySession>,
}
#[derive(Default)]
pub struct GitHistoryState(Mutex<HistoryInner>, AtomicBool);
struct OpeningGuard<'a>(&'a AtomicBool);
impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn git_root(file: &Path) -> Result<PathBuf, String> {
    if !super::has_markdown_extension(file) {
        return Err("Markdown only".into());
    }
    for directory in file.ancestors().skip(1).take(64) {
        if directory.join(".git").try_exists().map_err(err)? {
            return Ok(directory.to_path_buf());
        }
    }
    Err("No Git repository found".into())
}
fn direct_directory(path: &Path, boundary: &Path) -> Result<PathBuf, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(err)?;
    let canonical = std::fs::canonicalize(path).map_err(err)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() || !canonical.starts_with(boundary) {
        return Err("External Git directories are not supported".into());
    }
    Ok(canonical)
}
fn metadata_file(path: &Path, boundary: &Path, limit: u64) -> Result<(), String> {
    let boundary = std::fs::canonicalize(boundary).map_err(err)?;
    let metadata = std::fs::symlink_metadata(path).map_err(err)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > limit
        || !std::fs::canonicalize(path)
            .map_err(err)?
            .starts_with(&boundary)
    {
        return Err("Unsupported Git metadata file".into());
    }
    Ok(())
}
struct HistoryRepository {
    repository: Repository,
    git_dir: PathBuf,
    head: Option<Oid>,
}
impl std::ops::Deref for HistoryRepository {
    type Target = Repository;
    fn deref(&self) -> &Repository {
        &self.repository
    }
}
fn read_metadata(path: &Path, boundary: &Path, limit: usize) -> Result<String, String> {
    metadata_file(path, boundary, limit as u64)?;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(err)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err("Git metadata exceeds limit".into());
    }
    String::from_utf8(bytes).map_err(err)
}
fn head_id(git_dir: &Path) -> Result<Option<Oid>, String> {
    let mut value = read_metadata(&git_dir.join("HEAD"), git_dir, 4096)?;
    for _ in 0..8 {
        let Some(reference) = value.trim().strip_prefix("ref: ") else {
            let value = value.trim();
            if value.len() != 40 {
                return Err("Unsupported Git object format or HEAD".into());
            }
            return Oid::from_str(value).map(Some).map_err(err);
        };
        if !reference.starts_with("refs/")
            || reference.contains(['\\', ':', '\0'])
            || Path::new(reference)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("Invalid Git HEAD".into());
        }
        let mut candidate = git_dir.to_path_buf();
        for part in Path::new(reference).components() {
            candidate.push(part);
            if candidate.is_dir() {
                direct_directory(&candidate, git_dir)?;
            }
        }
        if candidate.try_exists().map_err(err)? {
            value = read_metadata(&candidate, git_dir, 4096)?;
            continue;
        }
        let packed = git_dir.join("packed-refs");
        if packed.try_exists().map_err(err)? {
            for line in read_metadata(&packed, git_dir, MAX_OBJECT_METADATA)?.lines() {
                if let Some((oid, name)) = line.split_once(' ') {
                    if name == reference {
                        if oid.len() != 40 {
                            return Err("Unsupported Git object format".into());
                        }
                        return Oid::from_str(oid).map(Some).map_err(err);
                    }
                }
            }
        }
        return Ok(None);
    }
    Err("Too many symbolic Git references".into())
}
fn open_repository(
    root: &Path,
    expected: Option<&Path>,
) -> Result<(HistoryRepository, PathBuf), String> {
    let git_dir = direct_directory(&root.join(".git"), root)?;
    if expected.is_some_and(|path| path != git_dir) {
        return Err("Git directory changed".into());
    }
    let objects = direct_directory(&git_dir.join("objects"), &git_dir)?;
    if git_dir.join("commondir").exists()
        || objects.join("info/alternates").exists()
        || objects.join("info/http-alternates").exists()
    {
        return Err("External Git object databases are not supported".into());
    }
    if objects.join("pack").exists() {
        direct_directory(&objects.join("pack"), &git_dir)?;
        for (index, entry) in std::fs::read_dir(objects.join("pack"))
            .map_err(err)?
            .enumerate()
        {
            if index >= 128 {
                return Err("Too many Git pack files".into());
            }
            metadata_file(
                &entry.map_err(err)?.path(),
                &git_dir,
                2 * 1024 * 1024 * 1024,
            )?;
        }
    }
    if objects.join("info").exists() {
        direct_directory(&objects.join("info"), &git_dir)?;
    }
    if git_dir.join("packed-refs").exists() {
        metadata_file(
            &git_dir.join("packed-refs"),
            &git_dir,
            MAX_OBJECT_METADATA as u64,
        )?;
    }
    let head = head_id(&git_dir)?;
    // Wrap only the validated object database. Opening a repository normally
    // would eagerly read local/global config, includes, grafts and shallow files.
    let odb = Odb::new().map_err(err)?;
    odb.add_disk_alternate(objects.to_str().ok_or("Invalid Git object path")?)
        .map_err(err)?;
    let repository = Repository::from_odb(odb).map_err(err)?;
    repository
        .set_config(&git2::Config::new().map_err(err)?)
        .map_err(err)?;
    Ok((
        HistoryRepository {
            repository,
            git_dir: git_dir.clone(),
            head,
        },
        git_dir,
    ))
}
fn bounded_object(
    repo: &HistoryRepository,
    oid: Oid,
    kind: ObjectType,
    limit: usize,
) -> Result<(), String> {
    let name = oid.to_string();
    let loose = repo
        .git_dir
        .join("objects")
        .join(&name[..2])
        .join(&name[2..]);
    if loose.exists() {
        metadata_file(&loose, &repo.git_dir, 32 * 1024 * 1024)?;
    }
    let (size, actual) = repo.odb().map_err(err)?.read_header(oid).map_err(err)?;
    if actual != kind || size > limit {
        return Err("Git object exceeds the comparison limit".into());
    }
    Ok(())
}
fn file_oid(repo: &HistoryRepository, commit: Oid, path: &Path) -> Result<Option<Oid>, String> {
    bounded_object(repo, commit, ObjectType::Commit, MAX_OBJECT_METADATA)?;
    let mut tree_id = repo.find_commit(commit).map_err(err)?.tree_id();
    let components: Vec<_> = path.components().collect();
    if components.is_empty() || components.len() > 128 {
        return Err("Invalid Git path".into());
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("Invalid Git path".into());
        };
        bounded_object(repo, tree_id, ObjectType::Tree, MAX_OBJECT_METADATA)?;
        let tree = repo.find_tree(tree_id).map_err(err)?;
        let Some(entry) = name.to_str().and_then(|name| tree.get_name(name)) else {
            return Ok(None);
        };
        if index + 1 == components.len() {
            if !matches!(entry.filemode(), 0o100644 | 0o100755) {
                return Err("Git symlinks and submodules are not supported".into());
            }
            return Ok(Some(entry.id()));
        }
        if entry.kind() != Some(ObjectType::Tree) {
            return Err("Invalid Git tree path".into());
        }
        tree_id = entry.id();
    }
    Ok(None)
}
fn history(
    repo: &HistoryRepository,
    relative: &Path,
) -> Result<(Vec<HistoryCommit>, bool), String> {
    let Some(mut id) = repo.head else {
        return Ok((vec![], false));
    };
    let started = Instant::now();
    let mut commits = Vec::new();
    for visited in 0..MAX_WALK {
        if started.elapsed() > Duration::from_secs(10) {
            return Ok((commits, true));
        }
        bounded_object(repo, id, ObjectType::Commit, MAX_OBJECT_METADATA)?;
        let commit = repo.find_commit(id).map_err(err)?;
        let current = file_oid(repo, id, relative)?;
        let parent = commit.parent_id(0).ok();
        let previous = parent
            .map(|id| file_oid(repo, id, relative))
            .transpose()?
            .flatten();
        if current != previous || visited == 0 {
            commits.push(HistoryCommit {
                id: id.to_string(),
                summary: commit
                    .summary()
                    .map_err(err)?
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect(),
                author: commit
                    .author()
                    .name()
                    .unwrap_or("")
                    .chars()
                    .take(100)
                    .collect(),
                timestamp: commit.time().seconds(),
            });
        }
        if commits.len() == MAX_HISTORY {
            return Ok((commits, parent.is_some()));
        }
        let Some(parent) = parent else {
            return Ok((commits, false));
        };
        id = parent;
    }
    Ok((commits, true))
}
fn read_allowed(roots: &AllowedRoots, path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let (file, actual) = open_allowed_file(roots, &path.to_string_lossy())?;
    if actual != path || file.metadata().map_err(err)?.len() > limit as u64 {
        return Err("File changed or exceeds comparison limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err("File exceeds comparison limit".into());
    }
    Ok(bytes)
}
impl HistorySession {
    fn repository(&self, roots: &AllowedRoots) -> Result<HistoryRepository, String> {
        if roots.resolve(&self.file.to_string_lossy())? != self.file
            || std::fs::canonicalize(&self.root).map_err(err)? != self.root
        {
            return Err("Document or repository changed".into());
        }
        open_repository(&self.root, Some(&self.git_dir)).map(|(repo, _)| repo)
    }
    fn revision(&self, revision: &str) -> Result<Oid, String> {
        if !self.commits.contains(revision) {
            return Err("Revision was not returned by this history session".into());
        }
        Oid::from_str(revision).map_err(err)
    }
    fn blob(
        &self,
        repo: &HistoryRepository,
        revision: &str,
        path: &Path,
        limit: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        let Some(oid) = file_oid(repo, self.revision(revision)?, path)? else {
            return Ok(None);
        };
        bounded_object(repo, oid, ObjectType::Blob, limit)?;
        Ok(Some(repo.find_blob(oid).map_err(err)?.content().to_vec()))
    }
}
fn image_path(document: &Path, target: &str) -> Result<PathBuf, String> {
    if target.len() > 4096
        || target.contains(['\0', ':', '?', '#', '\\'])
        || target.starts_with('/')
    {
        return Err("Invalid image path".into());
    }
    let mut parts: Vec<_> = document
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .map(|v| v.as_os_str().to_os_string())
        .collect();
    for component in Path::new(target).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => parts.push(name.to_os_string()),
            Component::ParentDir => {
                if parts.pop().is_none() {
                    return Err("Image outside repository".into());
                }
            }
            _ => return Err("Invalid image path".into()),
        }
    }
    let path: PathBuf = parts.into_iter().collect();
    if mime_from_extension(&path) == "application/octet-stream" {
        return Err("Unsupported image format".into());
    }
    Ok(path)
}

fn isolated_test_approval(file: &Path) -> bool {
    if !cfg!(debug_assertions)
        || std::env::var("HIRANOA_E2E_GIT_HISTORY_APPROVE").as_deref() != Ok("1")
    {
        return false;
    }
    let Some(state_dir) = std::env::var_os("HIRANOA_E2E_STATE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    else {
        return false;
    };
    let Some(parent) = state_dir.parent() else {
        return false;
    };
    std::fs::canonicalize(parent.join("fixtures")).is_ok_and(|fixtures| file.starts_with(fixtures))
}

#[tauri::command]
pub async fn open_git_history(
    app: AppHandle,
    document: DocumentRef,
    roots: State<'_, AllowedRoots>,
    registry: State<'_, SourceRegistry>,
    dialogs: State<'_, NativeDialogState>,
    state: State<'_, GitHistoryState>,
) -> Result<Option<HistoryInfo>, String> {
    state
        .1
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "History opening already in progress")?;
    let _opening = OpeningGuard(&state.1);
    let file = registry.history_document_path(&document, &roots)?;
    let root = git_root(&file)?;
    let guard = dialogs.try_acquire()?;
    let ja = crate::menu::resolve_locale(&app) == "ja";
    let prompt = if ja {
        format!("この文書と画像のGit履歴を読み取りますか？\n\n文書: {}\nリポジトリ: {}\n\nファイルを変更せず、通常のフォルダーアクセス権も広げません。", document.path, super::file::normalize_path_for_display(&root))
    } else {
        format!("Read Git history for this document and its images?\n\nDocument: {}\nRepository: {}\n\nNo files are changed. Normal folder access is not expanded.", document.path, super::file::normalize_path_for_display(&root))
    };
    let approved = isolated_test_approval(&file)
        || app
            .dialog()
            .message(prompt)
            .title(if ja {
                "Git履歴へのアクセス確認"
            } else {
                "Confirm Git history access"
            })
            .buttons(MessageDialogButtons::YesNo)
            .blocking_show();
    drop(guard);
    if !approved {
        return Ok(None);
    }
    if registry.history_document_path(&document, &roots)? != file {
        return Err("Document changed during confirmation".into());
    }
    let (repo, git_dir) = open_repository(&root, None)?;
    let relative = file.strip_prefix(&root).map_err(err)?.to_path_buf();
    let (commits, truncated) = history(&repo, &relative)?;
    let mut inner = state.0.lock().map_err(err)?;
    inner.next_id += 1;
    let id = format!("history-{}", inner.next_id);
    inner.session = Some(HistorySession {
        id: id.clone(),
        file,
        root,
        git_dir,
        relative: relative.clone(),
        commits: commits.iter().map(|c| c.id.clone()).collect(),
        assets: HashMap::new(),
        asset_bytes: 0,
    });
    Ok(Some(HistoryInfo {
        session_id: id,
        path: relative.to_string_lossy().replace('\\', "/"),
        commits,
        truncated,
    }))
}

#[tauri::command(async)]
pub fn read_git_snapshot(
    session_id: String,
    revision: String,
    roots: State<'_, AllowedRoots>,
    state: State<'_, GitHistoryState>,
) -> Result<HistorySnapshot, String> {
    let mut inner = state.0.lock().map_err(err)?;
    let session = inner
        .session
        .as_mut()
        .filter(|s| s.id == session_id)
        .ok_or("History session closed")?;
    let repo = session.repository(&roots)?;
    let bytes = if revision == "working" {
        session.assets.retain(|key, _| !key.starts_with("working:"));
        session.asset_bytes = session.assets.values().map(|(_, size)| size).sum();
        Some(read_allowed(&roots, &session.file, MAX_TEXT)?)
    } else {
        session.blob(&repo, &revision, &session.relative, MAX_TEXT)?
    };
    let present = bytes.is_some();
    let bytes = bytes.unwrap_or_default();
    if bytes.contains(&0) {
        return Err("Binary documents are not supported".into());
    }
    Ok(HistorySnapshot {
        raw: String::from_utf8(bytes).map_err(err)?,
        present,
    })
}

#[tauri::command(async)]
pub fn read_git_image(
    session_id: String,
    revision: String,
    target: String,
    roots: State<'_, AllowedRoots>,
    state: State<'_, GitHistoryState>,
) -> Result<String, String> {
    let mut inner = state.0.lock().map_err(err)?;
    let session = inner
        .session
        .as_mut()
        .filter(|s| s.id == session_id)
        .ok_or("History session closed")?;
    let repo = session.repository(&roots)?;
    let path = image_path(&session.relative, &target)?;
    let key = format!("{revision}:{}", path.to_string_lossy());
    if let Some((value, _)) = session.assets.get(&key) {
        return Ok(value.clone());
    }
    if session.assets.len() >= 100 {
        return Err("Image count limit reached".into());
    }
    let bytes = if revision == "working" {
        let actual = roots.resolve(&session.root.join(&path).to_string_lossy())?;
        if !actual.starts_with(&session.root)
            || mime_from_extension(&actual) != mime_from_extension(&path)
        {
            return Err("Image outside repository".into());
        }
        read_allowed(&roots, &actual, MAX_IMAGE)?
    } else {
        session
            .blob(&repo, &revision, &path, MAX_IMAGE)?
            .ok_or("Image not present at this revision")?
    };
    if session.asset_bytes + bytes.len() > MAX_ASSETS {
        return Err("Image budget exceeded".into());
    }
    session.asset_bytes += bytes.len();
    let data = format!(
        "data:{};base64,{}",
        mime_from_extension(&path),
        STANDARD.encode(&bytes)
    );
    session.assets.insert(key, (data.clone(), bytes.len()));
    Ok(data)
}

#[tauri::command]
pub fn close_git_history(
    session_id: String,
    state: State<'_, GitHistoryState>,
) -> Result<(), String> {
    let mut inner = state.0.lock().map_err(err)?;
    if inner.session.as_ref().is_some_and(|s| s.id == session_id) {
        inner.session = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn commit(repo: &Repository, root: &Path, text: &str, image: &[u8]) -> Oid {
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join("images")).unwrap();
        std::fs::write(root.join("docs/guide.md"), text).unwrap();
        std::fs::write(root.join("images/example.png"), image).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("docs/guide.md")).unwrap();
        index.add_path(Path::new("images/example.png")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Test author", "test@example.invalid").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "Document update",
            &tree,
            &parent.iter().collect::<Vec<_>>(),
        )
        .unwrap()
    }
    fn fixture() -> (tempfile::TempDir, HistorySession, AllowedRoots, Oid, Oid) {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let repo = Repository::init(&root).unwrap();
        let old = commit(&repo, &root, "# Guide\n\nold text\n", b"old-image");
        let new = commit(&repo, &root, "# Guide\n\nnew text\n", b"new-image");
        let roots = AllowedRoots::new();
        roots.register(&root.to_string_lossy()).unwrap();
        let session = HistorySession {
            id: "test".into(),
            file: root.join("docs/guide.md"),
            git_dir: root.join(".git"),
            root,
            relative: PathBuf::from("docs/guide.md"),
            commits: [old.to_string(), new.to_string()].into_iter().collect(),
            assets: HashMap::new(),
            asset_bytes: 0,
        };
        (directory, session, roots, old, new)
    }
    #[test]
    fn history_and_images_are_bound_to_revision_and_do_not_modify_index() {
        let (_directory, session, roots, old, new) = fixture();
        let before_index = std::fs::read(session.git_dir.join("index")).unwrap();
        let before_head = std::fs::read(session.git_dir.join("HEAD")).unwrap();
        let repo = session.repository(&roots).unwrap();
        let (items, truncated) = history(&repo, &session.relative).unwrap();
        assert!(!truncated);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, new.to_string());
        assert_eq!(
            session
                .blob(&repo, &old.to_string(), &session.relative, MAX_TEXT)
                .unwrap()
                .unwrap(),
            b"# Guide\n\nold text\n"
        );
        let image = image_path(&session.relative, "../images/example.png").unwrap();
        assert_eq!(
            session
                .blob(&repo, &old.to_string(), &image, MAX_IMAGE)
                .unwrap()
                .unwrap(),
            b"old-image"
        );
        assert_eq!(
            session
                .blob(&repo, &new.to_string(), &image, MAX_IMAGE)
                .unwrap()
                .unwrap(),
            b"new-image"
        );
        assert_eq!(
            std::fs::read(session.git_dir.join("index")).unwrap(),
            before_index
        );
        assert_eq!(
            std::fs::read(session.git_dir.join("HEAD")).unwrap(),
            before_head
        );
    }
    #[test]
    fn rejects_unreturned_revisions_and_escaping_image_paths() {
        let (_directory, session, roots, _, _) = fixture();
        let repo = session.repository(&roots).unwrap();
        for revision in ["HEAD", "HEAD:secret.txt", "--help", "../../private"] {
            assert!(session
                .blob(&repo, revision, &session.relative, MAX_TEXT)
                .is_err());
        }
        for target in [
            "../../secret.png",
            "/secret.png",
            "C:/secret.png",
            "https://example.com/a.png",
            "../secret.txt",
            "a\0.png",
            "..\\secret.png",
        ] {
            assert!(image_path(&session.relative, target).is_err(), "{target}");
        }
    }
    #[test]
    fn rejects_oversize_blobs_before_reading_and_missing_blobs_are_absent() {
        let (_directory, mut session, roots, _, _) = fixture();
        let repo = Repository::open(&session.root).unwrap();
        let id = commit(&repo, &session.root, &"a".repeat(MAX_TEXT + 1), b"image");
        session.commits.insert(id.to_string());
        let repo = session.repository(&roots).unwrap();
        assert!(session
            .blob(&repo, &id.to_string(), &session.relative, MAX_TEXT)
            .is_err());
        assert!(session
            .blob(&repo, &id.to_string(), Path::new("missing.md"), MAX_TEXT)
            .unwrap()
            .is_none());
        assert!(read_allowed(&roots, &session.file, MAX_TEXT).is_err());
    }
    #[test]
    fn rejects_external_git_directories_and_alternates() {
        let (_directory, session, roots, _, _) = fixture();
        std::fs::write(
            session.git_dir.join("objects/info/alternates"),
            "/outside/objects",
        )
        .unwrap();
        assert!(session.repository(&roots).is_err());
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(".git"), "gitdir: /outside/git").unwrap();
        assert!(open_repository(&std::fs::canonicalize(folder.path()).unwrap(), None).is_err());
    }
    #[test]
    fn empty_and_untracked_paths_have_bounded_behavior() {
        let folder = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(folder.path()).unwrap();
        Repository::init(&root).unwrap();
        let (repo, _) = open_repository(&root, None).unwrap();
        assert!(history(&repo, Path::new("untracked.md"))
            .unwrap()
            .0
            .is_empty());
        commit(&Repository::open(&root).unwrap(), &root, "text", b"image");
        let (repo, _) = open_repository(&root, None).unwrap();
        assert_eq!(
            history(&repo, Path::new("untracked.md")).unwrap().0.len(),
            1
        );
    }
    #[test]
    fn symlink_tree_entries_are_never_read_as_documents_or_images() {
        let (_directory, mut session, roots, _, _) = fixture();
        let repo = Repository::open(&session.root).unwrap();
        let blob = repo.blob(b"../../private.md").unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("guide.md", blob, 0o120000).unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        let id = repo
            .commit(None, &signature, &signature, "symlink", &tree, &[])
            .unwrap();
        session.commits.insert(id.to_string());
        let repo = session.repository(&roots).unwrap();
        assert!(session
            .blob(&repo, &id.to_string(), Path::new("guide.md"), MAX_TEXT)
            .is_err());
    }
    #[test]
    fn source_authorization_and_opening_guards_fail_closed() {
        let (_directory, session, _, _, _) = fixture();
        assert!(session.repository(&AllowedRoots::new()).is_err());
        let flag = AtomicBool::new(true);
        {
            let _guard = OpeningGuard(&flag);
        }
        assert!(!flag.load(Ordering::Acquire));
    }
    #[test]
    fn reads_only_odb_without_config_includes_grafts_or_shallow() {
        let (_directory, session, roots, _, _) = fixture();
        std::fs::write(
            session.git_dir.join("config"),
            "[include]\npath = /outside/huge\n[invalid config",
        )
        .unwrap();
        std::fs::create_dir_all(session.git_dir.join("info")).unwrap();
        std::fs::write(
            session.git_dir.join("info/grafts"),
            vec![b'x'; MAX_OBJECT_METADATA + 1],
        )
        .unwrap();
        std::fs::write(session.git_dir.join("shallow"), "invalid shallow data").unwrap();
        let repo = session.repository(&roots).unwrap();
        assert_eq!(history(&repo, &session.relative).unwrap().0.len(), 2);
    }
    #[test]
    fn resolves_packed_heads_and_bounds_symbolic_references() {
        let (_directory, session, roots, _, new) = fixture();
        std::fs::write(session.git_dir.join("HEAD"), "ref: refs/heads/packed\n").unwrap();
        std::fs::write(
            session.git_dir.join("packed-refs"),
            format!("{new} refs/heads/packed\n"),
        )
        .unwrap();
        assert_eq!(session.repository(&roots).unwrap().head, Some(new));
        std::fs::write(
            session.git_dir.join("refs/heads/packed"),
            "ref: refs/heads/loop\n",
        )
        .unwrap();
        std::fs::write(
            session.git_dir.join("refs/heads/loop"),
            "ref: refs/heads/packed\n",
        )
        .unwrap();
        assert!(session.repository(&roots).is_err());
        std::fs::write(session.git_dir.join("HEAD"), vec![b'x'; 4097]).unwrap();
        assert!(session.repository(&roots).is_err());
    }
}
