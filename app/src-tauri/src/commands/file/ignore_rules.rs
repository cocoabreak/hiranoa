use super::trusted_paths::{final_path_for_file, AllowedRoots};
use ignore::{
    gitignore::{Gitignore, GitignoreBuilder, Glob},
    DirEntry, Match, Walk, WalkBuilder,
};
use std::fs::File;
#[cfg(not(windows))]
use std::io;
use std::io::{BufRead, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const MAX_RULE_FILE_BYTES: u64 = 256 * 1024;

pub(crate) fn walk_entries(
    root: &Path,
    roots: &AllowedRoots,
    show_hidden: bool,
    respect_gitignore: bool,
    max_depth: Option<usize>,
) -> Walk {
    let mut builder = WalkBuilder::new(root);
    // The walker's built-in filters open rule files and Git metadata by path.
    builder
        .standard_filters(false)
        .hidden(!respect_gitignore && !show_hidden)
        .max_depth(max_depth);
    if respect_gitignore {
        let roots = roots.clone();
        let rules = Mutex::new(WalkRules {
            directories: Vec::new(),
            global: global_rules(),
        });
        builder
            .filter_entry(move |entry| rules.lock().unwrap().includes(entry, &roots, show_hidden));
    }
    builder.build()
}

struct WalkRules {
    directories: Vec<(PathBuf, DirectoryRules)>,
    global: Gitignore,
}

impl WalkRules {
    fn includes(&mut self, entry: &DirEntry, roots: &AllowedRoots, show_hidden: bool) -> bool {
        let path = entry.path();
        let Some(parent) = path.parent() else {
            return true;
        };
        while self
            .directories
            .last()
            .is_some_and(|(dir, _)| !parent.starts_with(dir))
        {
            self.directories.pop();
        }
        let last = self.directories.last().map(|(dir, _)| dir.as_path());
        let mut new_dirs = Vec::new();
        for dir in parent.ancestors().take_while(|dir| Some(*dir) != last) {
            if roots.resolve_opened_path(dir.to_path_buf()).is_err() {
                break;
            }
            new_dirs.push(dir);
        }
        for dir in new_dirs.into_iter().rev() {
            self.directories
                .push((dir.to_owned(), DirectoryRules::load(dir, roots)));
        }

        let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
        match self.matched(path, is_dir) {
            Match::Ignore(_) => false,
            Match::Whitelist(_) => true,
            Match::None => show_hidden || !is_hidden(entry),
        }
    }

    fn matched(&self, path: &Path, is_dir: bool) -> Match<&Glob> {
        // Preserve ignore's precedence: .ignore, .gitignore, info/exclude, then global.
        let nearest = self.directories.iter().rev().map(|(_, rules)| rules);
        let ignore = nearest
            .clone()
            .map(|rules| rules.ignore.matched(path, is_dir))
            .find(|rule| !rule.is_none())
            .unwrap_or(Match::None);
        if !ignore.is_none() {
            return ignore;
        }
        let repo = nearest.clone().enumerate().find(|(_, rules)| rules.is_git);
        // The repository marker may be above an approved subfolder. Its own
        // .gitignore still applies without probing that unapproved ancestor.
        let gitignore = nearest
            .take(repo.map_or(self.directories.len(), |(depth, _)| depth + 1))
            .map(|rules| rules.gitignore.matched(path, is_dir))
            .find(|rule| !rule.is_none())
            .unwrap_or(Match::None);
        match repo {
            Some((_, root)) => gitignore
                .or(root.exclude.matched(path, is_dir))
                .or(self.global.matched(path, is_dir)),
            None => gitignore,
        }
    }
}

fn is_hidden(entry: &DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_HIDDEN;
        if entry
            .metadata()
            .is_ok_and(|meta| meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0)
        {
            return true;
        }
    }
    entry.file_name().as_encoded_bytes().starts_with(b".")
}

struct DirectoryRules {
    ignore: Gitignore,
    gitignore: Gitignore,
    exclude: Gitignore,
    is_git: bool,
}

impl DirectoryRules {
    fn load(dir: &Path, roots: &AllowedRoots) -> Self {
        let open = |path: &Path| open_rule_path(roots, path);
        let dot_git = dir.join(".git");
        let git =
            open(&dot_git).and_then(|file| file.metadata().ok().map(|metadata| (file, metadata)));
        let (is_git, git_dir) = match git {
            Some((_, metadata)) if metadata.is_dir() => (true, Some(dot_git)),
            Some((file, metadata)) if metadata.is_file() => {
                let git_dir = read_text(file)
                    .and_then(|content| {
                        git_path(dir, content.lines().next()?.strip_prefix("gitdir: ")?)
                    })
                    .filter(|path| {
                        open(path)
                            .and_then(|f| f.metadata().ok())
                            .is_some_and(|m| m.is_dir())
                    });
                let common_dir = git_dir.and_then(|path| match open(&path.join("commondir")) {
                    Some(file) => {
                        read_text(file).and_then(|content| git_path(&path, content.lines().next()?))
                    }
                    None => Some(path),
                });
                (true, common_dir)
            }
            _ => {
                let is_jj = open(&dir.join(".jj")).is_some();
                (is_jj, None)
            }
        };
        Self {
            ignore: matcher(dir, open(&dir.join(".ignore"))),
            gitignore: matcher(dir, open(&dir.join(".gitignore"))),
            exclude: matcher(
                dir,
                git_dir.and_then(|path| open(&path.join("info/exclude"))),
            ),
            is_git,
        }
    }
}

fn git_path(base: &Path, value: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let spelling = value.replace('/', "\\");
    #[cfg(windows)]
    let value = spelling.as_str();
    let path = Path::new(value);
    if value.is_empty()
        || (!path.is_absolute()
            && (path.has_root()
                || path
                    .components()
                    .any(|part| matches!(part, Component::Prefix(_)))))
    {
        return None;
    }
    // Normalize dot segments before comparing a metadata-provided path to the trust boundary.
    let mut normalized = PathBuf::new();
    for part in base.join(path).components() {
        match part {
            Component::ParentDir if !normalized.pop() => return None,
            Component::ParentDir | Component::CurDir => {}
            _ => normalized.push(part.as_os_str()),
        }
    }
    if !normalized.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if let Some(Component::Prefix(prefix)) = normalized.components().next() {
            match prefix.kind() {
                Prefix::Disk(_) => return Some(format!(r"\\?\{}", normalized.to_str()?).into()),
                Prefix::UNC(_, _) => {
                    let tail = normalized.to_str()?.strip_prefix(r"\\")?;
                    return Some(format!(r"\\?\UNC\{tail}").into());
                }
                _ => {}
            }
        }
    }
    Some(normalized)
}

fn open_rule_path(roots: &AllowedRoots, path: &Path) -> Option<File> {
    roots.resolve_opened_path(path.to_path_buf()).ok()?;
    let requested = roots.share_checked_input(path.to_str()?).ok()?;
    let file = open_direct(&requested, true).ok()?;
    roots
        .resolve_opened_path(final_path_for_file(&file).ok()?)
        .ok()?;
    Some(file)
}

fn read_rule_bytes(file: File) -> Option<Vec<u8>> {
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RULE_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_RULE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_RULE_FILE_BYTES {
        return None;
    }
    Some(bytes)
}

fn read_text(file: File) -> Option<String> {
    String::from_utf8(read_rule_bytes(file)?).ok()
}

fn matcher(root: &Path, file: Option<File>) -> Gitignore {
    let Some(bytes) = file.and_then(read_rule_bytes) else {
        return Gitignore::empty();
    };
    let mut builder = GitignoreBuilder::new(root);
    for (index, line) in bytes.as_slice().lines().map_while(Result::ok).enumerate() {
        let line = if index == 0 {
            line.trim_start_matches('\u{feff}')
        } else {
            &line
        };
        let _ = builder.add_line(None, line);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn global_rules() -> Gitignore {
    use std::env;

    let Ok(cwd) = env::current_dir() else {
        return Gitignore::empty();
    };
    #[allow(deprecated)]
    let home = env::home_dir();
    let xdg = env::var_os("XDG_CONFIG_HOME")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|path| path.join(".config")));
    // Only the process environment and user/system config supply global rules.
    // Do not let them introduce a share or filesystem redirect during a document scan.
    let configs = [
        env::var_os("GIT_CONFIG_GLOBAL")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from),
        home.as_ref().map(|path| path.join(".gitconfig")),
        xdg.as_ref().map(|path| path.join("git/config")),
        env::var_os("GIT_CONFIG_SYSTEM")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .or_else(|| cfg!(unix).then(|| PathBuf::from("/etc/gitconfig"))),
    ];
    load_global_rules(
        &cwd,
        home.as_deref(),
        xdg.as_deref(),
        configs.into_iter().flatten(),
    )
}

fn load_global_rules(
    cwd: &Path,
    home: Option<&Path>,
    xdg: Option<&Path>,
    mut configs: impl Iterator<Item = PathBuf>,
) -> Gitignore {
    static EXCLUDES_FILE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let open_local =
        |path: PathBuf| open_direct(&std::path::absolute(cwd.join(path)).ok()?, false).ok();
    let setting = EXCLUDES_FILE.get_or_init(|| {
        regex::Regex::new(
            r#"(?imR)^[ \t]*excludesfile[ \t]*=[ \t]*"?[ \t]*(\S[^"\r\n]*?)[ \t]*"?[ \t]*$"#,
        )
        .expect("valid excludesFile pattern")
    });
    let excludes = configs
        .find_map(|path| {
            let content = read_text(open_local(path)?)?;
            let value = setting.captures(&content)?.get(1)?.as_str();
            if let Some(relative) = value
                .strip_prefix("~/")
                .or_else(|| value.strip_prefix("~\\"))
            {
                return home.map(|home| home.join(relative));
            }
            Some(PathBuf::from(value))
        })
        .or_else(|| xdg.map(|path| path.join("git/ignore")));
    matcher(cwd, excludes.and_then(open_local))
}

#[cfg(windows)]
use super::windows_open::open_direct;

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn open_direct(path: &Path, _allow_share: bool) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let mut parts = path.components().peekable();
    if parts.next() != Some(Component::RootDir) {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut current = File::open("/")?;
    while let Some(Component::Normal(part)) = parts.next() {
        let name = CString::new(part.as_bytes())?;
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if parts.peek().is_some() {
            flags |= libc::O_DIRECTORY;
        }
        // Keep each parent open while opening its child, without following links.
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        current = unsafe { File::from_raw_fd(fd) };
        if parts.peek().is_none() {
            return Ok(current);
        }
    }
    Err(io::ErrorKind::InvalidInput.into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn open_direct(_path: &Path, _allow_share: bool) -> io::Result<File> {
    Err(io::ErrorKind::Unsupported.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn entry_names(root: &Path, roots: &AllowedRoots, respect_gitignore: bool) -> Vec<String> {
        walk_entries(root, roots, false, respect_gitignore, None)
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn layered_rules_keep_negation_precedence_and_nested_repository_boundaries() {
        let folder = tempfile::tempdir().unwrap();
        let roots = AllowedRoots::new();
        let repo = folder.path();
        let sub = repo.join("sub");
        let nested_repo = repo.join("nested");
        for dir in [
            repo.join(".git/info"),
            sub.clone(),
            nested_repo.join(".git"),
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(repo.join(".gitignore"), "parent-*.md\nvisible.md\n").unwrap();
        fs::write(repo.join(".git/info/exclude"), "repo-only.md\n").unwrap();
        fs::write(repo.join(".ignore"), "!visible.md\n").unwrap();
        fs::write(
            sub.join(".gitignore"),
            "!parent-kept.md\n!.whitelisted.md\n",
        )
        .unwrap();
        for path in [
            sub.join("parent-kept.md"),
            sub.join("parent-hidden.md"),
            sub.join("repo-only.md"),
            sub.join(".whitelisted.md"),
            repo.join("visible.md"),
            nested_repo.join("parent-nested.md"),
        ] {
            fs::write(path, "").unwrap();
        }
        roots.register(repo.to_str().unwrap()).unwrap();
        let repo = roots.resolve(repo.to_str().unwrap()).unwrap();
        let mut filtered = entry_names(&repo, &roots, true);
        filtered.sort();
        assert_eq!(
            filtered,
            [
                ".whitelisted.md",
                "parent-kept.md",
                "parent-nested.md",
                "visible.md"
            ]
        );
        let unfiltered = entry_names(&repo, &roots, false);
        assert!(unfiltered.iter().any(|name| name == "repo-only.md"));
        assert!(unfiltered.iter().any(|name| name == "parent-hidden.md"));
        assert!(!unfiltered.iter().any(|name| name == ".whitelisted.md"));
    }

    #[test]
    fn worktree_exclusions_are_read_inside_the_approved_root() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path();
        let work = root.join("work");
        let metadata = root.join("metadata");
        let common = root.join("common");
        fs::create_dir(&work).unwrap();
        fs::create_dir(&metadata).unwrap();
        fs::create_dir_all(common.join("info")).unwrap();
        fs::write(metadata.join("commondir"), "../common\n").unwrap();
        fs::write(common.join("info/exclude"), "hidden.md\n").unwrap();
        fs::write(work.join("hidden.md"), "").unwrap();
        fs::write(work.join("visible.md"), "").unwrap();

        let roots = AllowedRoots::new();
        roots.register(root.to_str().unwrap()).unwrap();
        let root = roots.resolve(root.to_str().unwrap()).unwrap();
        let walk_root = root.join("work");
        let metadata = root.join("metadata");
        // Use the approved path spelling; the OS temp path can be an alias.
        let absolute = super::super::readers::normalize_path_for_display(&metadata);
        for git_dir in [absolute.as_str(), "../metadata"] {
            assert_eq!(git_path(&walk_root, git_dir).as_ref(), Some(&metadata));
            fs::write(walk_root.join(".git"), format!("gitdir: {git_dir}\n")).unwrap();
            assert_eq!(entry_names(&walk_root, &roots, true), ["visible.md"]);
        }
    }

    #[test]
    fn automatic_rules_skip_unapproved_ancestors() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().join("approved");
        fs::create_dir(&root).unwrap();
        fs::create_dir(folder.path().join(".git")).unwrap();
        fs::write(folder.path().join(".ignore"), "visible.md\n").unwrap();
        fs::write(root.join(".gitignore"), b"draft.md\n\xff").unwrap();
        fs::write(root.join("draft.md"), "").unwrap();
        fs::write(root.join("visible.md"), "").unwrap();
        let roots = AllowedRoots::new();
        roots.register(root.to_str().unwrap()).unwrap();
        let root = roots.resolve(root.to_str().unwrap()).unwrap();
        assert!(open_rule_path(&roots, &root.parent().unwrap().join(".ignore")).is_none());
        assert_eq!(entry_names(&root, &roots, true), ["visible.md"]);
    }

    #[test]
    fn local_global_excludes_still_support_user_configuration() {
        let folder = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(folder.path()).unwrap();
        let config = home.join(".gitconfig");
        fs::write(
            &config,
            "[core]\r\n  excludesFile = \"~/ignore rules.txt\"\r\n",
        )
        .unwrap();
        fs::write(home.join("ignore rules.txt"), "*.md\n!kept.md\n").unwrap();
        let rules = load_global_rules(&home, Some(&home), None, [config].into_iter());
        assert!(rules.matched(home.join("hidden.md"), false).is_ignore());
        assert!(rules.matched(home.join("kept.md"), false).is_whitelist());
    }
}
