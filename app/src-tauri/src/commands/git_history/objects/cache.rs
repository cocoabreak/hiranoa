use super::err;
use std::fs::{self, File};
use std::io;
use std::path::Path;
use tempfile::TempDir;

const PREFIX: &str = "session-";
const RANDOM_BYTES: usize = 12;
const OWNER: &str = "owner.lock";
const FREE_SPACE_RESERVE: u64 = 128 * 1024 * 1024;

pub(super) struct Cache {
    // Release the lock before TempDir tries to remove the owner file on Windows.
    _owner: File,
    directory: TempDir,
}

impl Cache {
    pub(super) fn new(app_cache: &Path) -> Result<Self, String> {
        fs::create_dir_all(app_cache).map_err(err)?;
        let root = fs::canonicalize(app_cache)
            .map_err(err)?
            .join("git-history");
        #[cfg(unix)]
        let created = {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&root)
        };
        #[cfg(not(unix))]
        let created = fs::create_dir(&root);
        match created {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            result => result.map_err(err)?,
        }
        if fs::canonicalize(&root).map_err(err)? != root {
            return Err("Invalid Git history cache directory".into());
        }
        let setup_lock = open_setup_lock(&root)?;
        setup_lock.lock().map_err(err)?;
        remove_abandoned_sessions(&root);

        let mut builder = tempfile::Builder::new();
        builder.prefix(PREFIX).rand_bytes(RANDOM_BYTES);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let directory = builder.tempdir_in(&root).map_err(err)?;
        let owner = File::create_new(directory.path().join(OWNER)).map_err(err)?;
        owner.lock().map_err(err)?;
        Ok(Self {
            _owner: owner,
            directory,
        })
    }

    pub(super) fn path(&self) -> &Path {
        self.directory.path()
    }

    pub(super) fn check_space(&self, copy_bytes: u64) -> Result<(), String> {
        if free_space(self.path()).map_err(err)? < u128::from(copy_bytes + FREE_SPACE_RESERVE) {
            return Err("Not enough free space for Git history".into());
        }
        Ok(())
    }
}

pub(super) fn cleanup_existing_cache(app_cache: &Path) -> Result<(), String> {
    let app_cache = match fs::canonicalize(app_cache) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(error)),
    };
    let root = app_cache.join("git-history");
    match fs::canonicalize(&root) {
        Ok(path) if path == root => {}
        Ok(_) => return Err("Invalid Git history cache directory".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(err(error)),
    }
    let setup_lock = open_setup_lock(&root)?;
    // A session creating its cache also cleans this directory under this lock.
    if setup_lock.try_lock().is_ok() {
        remove_abandoned_sessions(&root);
    }
    Ok(())
}

fn open_setup_lock(root: &Path) -> Result<File, String> {
    File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("setup.lock"))
        .map_err(err)
}

fn remove_abandoned_sessions(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix(PREFIX)) else {
            continue;
        };
        if suffix.len() != RANDOM_BYTES
            || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let path = entry.path();
        if !fs::canonicalize(&path).is_ok_and(|resolved| resolved == path) {
            continue;
        }
        let abandoned = match File::options()
            .read(true)
            .write(true)
            .open(path.join(OWNER))
        {
            Ok(owner) => owner.try_lock().is_ok(),
            Err(error) => error.kind() == io::ErrorKind::NotFound,
        };
        if abandoned {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(windows)]
fn free_space(path: &Path) -> io::Result<u128> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let path: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0;
    // SAFETY: path is NUL-terminated and available is a writable output value.
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(u128::from(available))
}

#[cfg(unix)]
fn free_space(path: &Path) -> io::Result<u128> {
    use std::ffi::CString;
    use std::mem::MaybeUninit;
    use std::os::unix::ffi::OsStrExt;

    let path = CString::new(path.as_os_str().as_bytes())?;
    let mut stats = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and stats points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statvfs initialized the result on success.
    let stats = unsafe { stats.assume_init() };
    Ok(u128::from(stats.f_bavail) * u128::from(stats.f_frsize))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclaims_abandoned_cache_and_preserves_active_sessions() {
        let parent = tempfile::tempdir().unwrap();
        let live = Cache::new(parent.path()).unwrap();
        let abandoned = live.path().parent().unwrap().join("session-abandoned123");
        fs::create_dir(&abandoned).unwrap();
        File::create_new(abandoned.join(OWNER)).unwrap();
        fs::write(abandoned.join("pack-0.pack"), b"old cache").unwrap();

        cleanup_existing_cache(parent.path()).unwrap();
        assert!(live.path().is_dir());
        assert!(!abandoned.exists());

        let live_path = live.path().to_owned();
        drop(live);
        assert!(!live_path.exists());
    }
}
