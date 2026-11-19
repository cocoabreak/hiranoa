use super::file::readers::native_image_mime_type;
use super::file::trusted_paths::{final_path_for_file, open_path_attributes_without_links};
use super::file::{
    image_mime_type, trusted_paths::open_allowed_file, AllowedRoots, NativeDialogState,
};
use super::sources::{DocumentRef, SourceRegistry};
use base64::{engine::general_purpose::STANDARD, Engine};
use git2::{ObjectType, Odb, Oid, Repository};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

mod objects;
use objects::{GitDirectory, StagedObjects};

const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_IMAGE: usize = 5 * 1024 * 1024;
const MAX_ASSETS: usize = 32 * 1024 * 1024;
const MAX_HISTORY: usize = 100;
const MAX_WALK: usize = 5000;
const MAX_OBJECT_METADATA: usize = 2 * 1024 * 1024;
const HISTORY_READ_TIME: Duration = Duration::from_secs(10);

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
    repository: HistoryRepository,
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

pub(crate) fn cleanup_history_cache(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = objects::cleanup_existing_cache(&cache) {
                eprintln!("failed to clean up Git history cache: {error}");
            }
        });
    }
}
/// Without history consent, stop at the first ancestor outside AllowedRoots.
/// A consented search is still restricted to this document's direct ancestors.
fn git_root(file: &Path, before_consent: Option<&AllowedRoots>) -> Result<Option<PathBuf>, String> {
    if !super::has_markdown_extension(file) {
        return Err("Markdown only".into());
    }
    for directory in file
        .ancestors()
        .skip(1)
        .take(64)
        .take_while(|dir| dir.is_absolute())
    {
        let path = directory.join(".git");
        let marker = if let Some(roots) = before_consent {
            if roots.resolve_opened_path(directory.to_owned()).is_err() {
                break;
            }
            roots
                .inspect_allowed_path_without_links(&path)?
                .map(|(_, metadata)| metadata)
        } else {
            git_path_attributes(&path)?
        };
        if let Some(marker) = marker {
            if !marker.is_dir() {
                return Err("External Git directories are not supported".into());
            }
            return Ok(Some(directory.to_path_buf()));
        }
    }
    Ok(None)
}

fn probe_git_path(
    path: &Path,
    open: impl FnOnce(&Path, bool) -> io::Result<File>,
) -> Result<Option<File>, String> {
    let file = match open(path, true) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    if final_path_for_file(&file)? != path {
        return Err("Git path changed while it was being checked".into());
    }
    Ok(Some(file))
}

fn git_path_attributes(path: &Path) -> Result<Option<Metadata>, String> {
    probe_git_path(path, open_path_attributes_without_links)?
        .map(|file| file.metadata().map_err(err))
        .transpose()
}

struct HistoryRepository {
    // Drop the libgit2 backends before deleting their staged files.
    repository: Repository,
    objects: StagedObjects,
    git_dir: GitDirectory,
    head: Option<Oid>,
}
impl std::ops::Deref for HistoryRepository {
    type Target = Repository;
    fn deref(&self) -> &Repository {
        &self.repository
    }
}
fn read_metadata(file: File, limit: usize) -> Result<String, String> {
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > limit {
        return Err("Git metadata exceeds limit".into());
    }
    String::from_utf8(bytes).map_err(err)
}
fn head_id(git_dir: &GitDirectory) -> Result<Option<Oid>, String> {
    let (head, _) = git_dir
        .open_file(Path::new("HEAD"), 4096)?
        .ok_or("Missing Git HEAD")?;
    let mut value = read_metadata(head, 4096)?;
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
        let candidate = Path::new(reference).components().collect::<PathBuf>();
        if let Some((file, _)) = git_dir.open_file(&candidate, 4096)? {
            value = read_metadata(file, 4096)?;
            continue;
        }
        if let Some((file, _)) =
            git_dir.open_file(Path::new("packed-refs"), MAX_OBJECT_METADATA as u64)?
        {
            for line in read_metadata(file, MAX_OBJECT_METADATA)?.lines() {
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
fn open_repository(root: &Path, cache: &Path) -> Result<HistoryRepository, String> {
    let git_dir = GitDirectory::open(root.join(".git"))?;
    let objects = git_dir
        .subdirectory("objects")?
        .ok_or("Missing Git objects directory")?;
    if git_dir.has_entry("commondir")?
        || objects.has_entry("info/alternates")?
        || objects.has_entry("info/http-alternates")?
    {
        return Err("External Git object databases are not supported".into());
    }
    git_dir.open_file(Path::new("packed-refs"), MAX_OBJECT_METADATA as u64)?;
    let head = head_id(&git_dir)?;
    let objects = StagedObjects::new(objects, cache)?;
    let odb = Odb::new().map_err(err)?;
    objects.register_loose(&odb)?;
    // A normal repository open would read config, includes and other metadata.
    let repository = Repository::from_odb(odb).map_err(err)?;
    repository
        .set_config(&git2::Config::new().map_err(err)?)
        .map_err(err)?;
    Ok(HistoryRepository {
        repository,
        objects,
        git_dir,
        head,
    })
}
fn bounded_object(
    repo: &HistoryRepository,
    oid: Oid,
    kind: ObjectType,
    limit: usize,
    deadline: Instant,
) -> Result<(), String> {
    let odb = repo.odb().map_err(err)?;
    let mut header = odb.read_header(oid);
    if header
        .as_ref()
        .is_err_and(|error| error.code() == git2::ErrorCode::NotFound)
        && (repo.objects.stage_loose(oid, deadline)?
            || repo.objects.stage_pack(&odb, oid, deadline)?)
    {
        header = odb.read_header(oid);
    }
    let (size, actual) = header.map_err(err)?;
    if actual != kind || size > limit {
        return Err("Git object exceeds the comparison limit".into());
    }
    Ok(())
}
fn file_oid(
    repo: &HistoryRepository,
    commit: Oid,
    path: &Path,
    deadline: Instant,
) -> Result<Option<Oid>, String> {
    bounded_object(
        repo,
        commit,
        ObjectType::Commit,
        MAX_OBJECT_METADATA,
        deadline,
    )?;
    let mut tree_id = repo.find_commit(commit).map_err(err)?.tree_id();
    let components: Vec<_> = path.components().collect();
    if components.is_empty() || components.len() > 128 {
        return Err("Invalid Git path".into());
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err("Invalid Git path".into());
        };
        bounded_object(
            repo,
            tree_id,
            ObjectType::Tree,
            MAX_OBJECT_METADATA,
            deadline,
        )?;
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
    let deadline = Instant::now() + HISTORY_READ_TIME;
    let mut commits = Vec::new();
    for visited in 0..MAX_WALK {
        if Instant::now() >= deadline {
            return Ok((commits, true));
        }
        let step = (|| {
            bounded_object(repo, id, ObjectType::Commit, MAX_OBJECT_METADATA, deadline)?;
            let commit = repo.find_commit(id).map_err(err)?;
            let current = file_oid(repo, id, relative, deadline)?;
            let parent = commit.parent_id(0).ok();
            let previous = parent
                .map(|id| file_oid(repo, id, relative, deadline))
                .transpose()?
                .flatten();
            Ok::<_, String>((commit, current, parent, previous))
        })();
        let (commit, current, parent, previous) = match step {
            Err(_) if !commits.is_empty() && Instant::now() >= deadline => {
                return Ok((commits, true));
            }
            result => result?,
        };
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
    fn repository(&self, roots: &AllowedRoots) -> Result<&HistoryRepository, String> {
        if !roots
            .inspect_allowed_path_without_links(&self.file)?
            .is_some_and(|(opened, metadata)| opened == self.file && metadata.is_file())
        {
            return Err("Document or repository changed".into());
        }
        self.repository.git_dir.verify_location()?;
        self.repository.objects.verify_location()?;
        Ok(&self.repository)
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
        let deadline = Instant::now() + HISTORY_READ_TIME;
        let Some(oid) = file_oid(repo, self.revision(revision)?, path, deadline)? else {
            return Ok(None);
        };
        bounded_object(repo, oid, ObjectType::Blob, limit, deadline)?;
        Ok(Some(repo.find_blob(oid).map_err(err)?.content().to_vec()))
    }
}
fn image_path(document: &Path, target: &str) -> Result<(PathBuf, &'static str), String> {
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
    let mime = image_mime_type(&path).ok_or("Unsupported image format")?;
    Ok((path, mime))
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
    let known_root = git_root(&file, Some(&roots))?;
    let guard = dialogs.try_acquire()?;
    let ja = crate::menu::resolve_locale(&app) == "ja";
    let display = super::file::normalize_path_for_display;
    let repository = match (&known_root, ja) {
        (Some(root), true) => format!("リポジトリ: {}", display(root)),
        (Some(root), false) => format!("Repository: {}", display(root)),
        (None, true) => "承認後、この文書の親フォルダーからリポジトリを探します。".into(),
        (None, false) => {
            "After approval, the app will look for a repository in this document's parent folders."
                .into()
        }
    };
    let prompt = if ja {
        format!("この文書と画像のGit履歴を読み取りますか？\n\n文書: {}\n{repository}\n\nファイルを変更せず、通常のフォルダーアクセス権も広げません。", display(&file))
    } else {
        format!("Read Git history for this document and its images?\n\nDocument: {}\n{repository}\n\nNo files are changed. Normal folder access is not expanded.", display(&file))
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
    let root = match known_root {
        Some(root) => root,
        None => git_root(&file, None)?.ok_or("No Git repository found")?,
    };
    let relative = file.strip_prefix(&root).map_err(err)?.to_path_buf();
    let cache = app.path().app_cache_dir().map_err(err)?;
    let (repository, commits, truncated) = tauri::async_runtime::spawn_blocking({
        let root = root.clone();
        let relative = relative.clone();
        move || {
            let repository = open_repository(&root, &cache)?;
            let (commits, truncated) = history(&repository, &relative)?;
            Ok::<_, String>((repository, commits, truncated))
        }
    })
    .await
    .map_err(err)??;
    let mut inner = state.0.lock().map_err(err)?;
    inner.next_id += 1;
    let id = format!("history-{}", inner.next_id);
    let previous = inner.session.replace(HistorySession {
        id: id.clone(),
        file,
        root,
        repository,
        relative: relative.clone(),
        commits: commits.iter().map(|c| c.id.clone()).collect(),
        assets: HashMap::new(),
        asset_bytes: 0,
    });
    drop(inner);
    if let Some(previous) = previous {
        tauri::async_runtime::spawn_blocking(move || drop(previous));
    }
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
        session.blob(repo, &revision, &session.relative, MAX_TEXT)?
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
    let (path, mime) = image_path(&session.relative, &target)?;
    let key = format!("{revision}:{}", path.to_string_lossy());
    if let Some((value, _)) = session.assets.get(&key) {
        return Ok(value.clone());
    }
    if session.assets.len() >= 100 {
        return Err("Image count limit reached".into());
    }
    let bytes = if revision == "working" {
        let actual = roots.resolve(&session.root.join(&path).to_string_lossy())?;
        if !actual.starts_with(&session.root) || native_image_mime_type(&actual) != Some(mime) {
            return Err("Image outside repository".into());
        }
        read_allowed(&roots, &actual, MAX_IMAGE)?
    } else {
        session
            .blob(repo, &revision, &path, MAX_IMAGE)?
            .ok_or("Image not present at this revision")?
    };
    if session.asset_bytes + bytes.len() > MAX_ASSETS {
        return Err("Image budget exceeded".into());
    }
    session.asset_bytes += bytes.len();
    let data = format!("data:{mime};base64,{}", STANDARD.encode(&bytes));
    session.assets.insert(key, (data.clone(), bytes.len()));
    Ok(data)
}

#[tauri::command]
pub async fn close_git_history(session_id: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GitHistoryState>();
        let session = {
            let mut inner = state.0.lock().map_err(err)?;
            if inner.session.as_ref().is_some_and(|s| s.id == session_id) {
                inner.session.take()
            } else {
                None
            }
        };
        drop(session);
        Ok(())
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn open_test_repository(root: &Path) -> Result<HistoryRepository, String> {
        open_repository(root, &root.join("test-cache"))
    }

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
            repository: open_test_repository(&root).unwrap(),
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
        let git_dir = &session.repository.git_dir.path;
        let before_index = std::fs::read(git_dir.join("index")).unwrap();
        let before_head = std::fs::read(git_dir.join("HEAD")).unwrap();
        let repo = session.repository(&roots).unwrap();
        let (items, truncated) = history(repo, &session.relative).unwrap();
        assert!(!truncated);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, new.to_string());
        assert_eq!(
            session
                .blob(repo, &old.to_string(), &session.relative, MAX_TEXT)
                .unwrap()
                .unwrap(),
            b"# Guide\n\nold text\n"
        );
        let (image, _) = image_path(&session.relative, "../images/example.png").unwrap();
        assert_eq!(
            session
                .blob(repo, &old.to_string(), &image, MAX_IMAGE)
                .unwrap()
                .unwrap(),
            b"old-image"
        );
        assert_eq!(
            session
                .blob(repo, &new.to_string(), &image, MAX_IMAGE)
                .unwrap()
                .unwrap(),
            b"new-image"
        );
        assert_eq!(std::fs::read(git_dir.join("index")).unwrap(), before_index);
        assert_eq!(std::fs::read(git_dir.join("HEAD")).unwrap(), before_head);
    }

    #[test]
    fn history_reads_a_new_pack_after_maintenance_and_keeps_the_copy() {
        let (_directory, session, roots, old, new) = fixture();
        let objects = session.repository.git_dir.path.join("objects");
        let pack = objects.join("pack");
        let repo = session.repository(&roots).unwrap();
        assert_eq!(history(repo, &session.relative).unwrap().0.len(), 2);
        {
            let repo = Repository::open(&session.root).unwrap();
            let mut builder = repo.packbuilder().unwrap();
            builder.insert_commit(old).unwrap();
            builder.insert_commit(new).unwrap();
            builder.write(&pack, 0).unwrap();
        }
        for entry in std::fs::read_dir(&objects).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name();
            if name.len() == 2 && name.as_encoded_bytes().iter().all(u8::is_ascii_hexdigit) {
                std::fs::remove_dir_all(entry.path()).unwrap();
            }
        }
        let image = Path::new("images/example.png");
        assert_eq!(
            session
                .blob(repo, &old.to_string(), image, MAX_IMAGE)
                .unwrap(),
            Some(b"old-image".to_vec())
        );
        for entry in std::fs::read_dir(&pack).unwrap() {
            std::fs::remove_file(entry.unwrap().path()).unwrap();
        }
        let (items, truncated) = history(repo, &session.relative).unwrap();
        assert!(!truncated);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, new.to_string());
        assert_eq!(
            session
                .blob(repo, &new.to_string(), image, MAX_IMAGE)
                .unwrap(),
            Some(b"new-image".to_vec())
        );
    }

    #[test]
    fn rejects_unreturned_revisions_and_escaping_image_paths() {
        let (_directory, session, roots, _, _) = fixture();
        let repo = session.repository(&roots).unwrap();
        for revision in ["HEAD", "HEAD:secret.txt", "--help", "../../private"] {
            assert!(session
                .blob(repo, revision, &session.relative, MAX_TEXT)
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
            .blob(repo, &id.to_string(), &session.relative, MAX_TEXT)
            .is_err());
        assert!(session
            .blob(repo, &id.to_string(), Path::new("missing.md"), MAX_TEXT)
            .unwrap()
            .is_none());
        assert!(read_allowed(&roots, &session.file, MAX_TEXT).is_err());
    }
    #[test]
    fn rejects_external_git_directories_and_alternates() {
        let (_directory, session, _, _, _) = fixture();
        std::fs::write(
            session
                .repository
                .git_dir
                .path
                .join("objects/info/alternates"),
            "/outside/objects",
        )
        .unwrap();
        assert!(open_test_repository(&session.root).is_err());
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(folder.path().join(".git"), "gitdir: /outside/git").unwrap();
        assert!(open_test_repository(&std::fs::canonicalize(folder.path()).unwrap()).is_err());
    }
    #[test]
    fn empty_and_untracked_paths_have_bounded_behavior() {
        let folder = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(folder.path()).unwrap();
        Repository::init(&root).unwrap();
        let repo = open_test_repository(&root).unwrap();
        assert!(history(&repo, Path::new("untracked.md"))
            .unwrap()
            .0
            .is_empty());
        commit(&Repository::open(&root).unwrap(), &root, "text", b"image");
        let repo = open_test_repository(&root).unwrap();
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
            .blob(repo, &id.to_string(), Path::new("guide.md"), MAX_TEXT)
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
    fn history_discovery_stops_before_an_unapproved_parent() {
        let folder = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(folder.path()).unwrap();
        let docs = root.join("docs");
        std::fs::create_dir(&docs).unwrap();
        let file = docs.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        Repository::init(&root).unwrap();

        let roots = AllowedRoots::new();
        roots.register(&docs.to_string_lossy()).unwrap();
        assert_eq!(git_root(&file, Some(&roots)).unwrap(), None);
        assert_eq!(git_root(&file, None).unwrap(), Some(root.clone()));

        roots.register(&root.to_string_lossy()).unwrap();
        assert_eq!(git_root(&file, Some(&roots)).unwrap(), Some(root));
    }

    #[test]
    fn direct_repository_discovery_rejects_a_git_pointer_without_resolving_it() {
        let folder = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(folder.path()).unwrap();
        let file = root.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        std::fs::write(root.join(".git"), "gitdir: unused").unwrap();
        let roots = AllowedRoots::new();
        roots.register(&root.to_string_lossy()).unwrap();

        assert_eq!(
            git_root(&file, Some(&roots)).unwrap_err(),
            "External Git directories are not supported"
        );
        assert!(git_root(&file, None).is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn a_link_is_never_a_direct_git_directory() {
        let folder = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(folder.path()).unwrap();
        let metadata = root.join("metadata");
        std::fs::create_dir(&metadata).unwrap();
        let marker = root.join(".git");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&metadata, &marker);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&metadata, &marker);
        #[cfg(windows)]
        if linked.as_ref().err().and_then(io::Error::raw_os_error) == Some(1314) {
            return; // This test runner cannot create filesystem links.
        }
        linked.unwrap();
        let file = root.join("guide.md");
        std::fs::write(&file, "# Guide").unwrap();
        let roots = AllowedRoots::new();
        roots.register(&root.to_string_lossy()).unwrap();
        assert!(git_root(&file, Some(&roots)).is_err());
        assert!(git_root(&file, None).is_err());
    }
    #[test]
    fn reads_only_odb_without_config_includes_grafts_or_shallow() {
        let (_directory, session, _, _, _) = fixture();
        let git_dir = &session.repository.git_dir.path;
        std::fs::write(
            git_dir.join("config"),
            "[include]\npath = /outside/huge\n[invalid config",
        )
        .unwrap();
        std::fs::create_dir_all(git_dir.join("info")).unwrap();
        std::fs::write(
            git_dir.join("info/grafts"),
            vec![b'x'; MAX_OBJECT_METADATA + 1],
        )
        .unwrap();
        std::fs::write(git_dir.join("shallow"), "invalid shallow data").unwrap();
        let repo = open_test_repository(&session.root).unwrap();
        assert_eq!(history(&repo, &session.relative).unwrap().0.len(), 2);
    }
    #[test]
    fn resolves_packed_heads_and_bounds_symbolic_references() {
        let (_directory, session, _, _, new) = fixture();
        let git_dir = &session.repository.git_dir.path;
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/packed\n").unwrap();
        std::fs::write(
            git_dir.join("packed-refs"),
            format!("{new} refs/heads/packed\n"),
        )
        .unwrap();
        assert_eq!(open_test_repository(&session.root).unwrap().head, Some(new));
        std::fs::write(git_dir.join("refs/heads/packed"), "ref: refs/heads/loop\n").unwrap();
        std::fs::write(git_dir.join("refs/heads/loop"), "ref: refs/heads/packed\n").unwrap();
        assert!(open_test_repository(&session.root).is_err());
        std::fs::write(git_dir.join("HEAD"), vec![b'x'; 4097]).unwrap();
        assert!(open_test_repository(&session.root).is_err());
    }
}
