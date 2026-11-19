use super::{err, probe_git_path};
use crate::commands::file::directory_scan::{
    open_directory_child, read_directory_names, ChildAccess,
};
use crate::commands::file::trusted_paths::{final_path_for_file, open_directory_for_traversal};
use git2::{Binding, IntoCString, Odb, Oid};
use libgit2_sys as raw;
use std::cell::Cell;
use std::fs::{self, File};
use std::io::{self, Read, Seek};
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::Instant;
use tempfile::NamedTempFile;

mod cache;
mod pack_index;
use cache::Cache;

pub(super) fn cleanup_existing_cache(path: &Path) -> Result<(), String> {
    cache::cleanup_existing_cache(path)
}

const MAX_PACK_ENTRIES: usize = 128;
const MAX_PACK_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_LOOSE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_STAGED_LOOSE_BYTES: u64 = 256 * 1024 * 1024;

pub(super) struct GitDirectory {
    pub(super) path: PathBuf,
    handle: File,
}

impl GitDirectory {
    pub(super) fn open(path: PathBuf) -> Result<Self, String> {
        let handle = probe_git_path(&path, open_directory_for_traversal)?
            .ok_or("Git directory not found")?;
        if !handle.metadata().map_err(err)?.is_dir() {
            return Err("External Git directories are not supported".into());
        }
        Ok(Self { path, handle })
    }

    pub(super) fn verify_location(&self) -> Result<(), String> {
        if final_path_for_file(&self.handle)? != self.path {
            return Err("Git directory changed".into());
        }
        Ok(())
    }

    pub(super) fn subdirectory(&self, name: &str) -> Result<Option<Self>, String> {
        self.open_subdirectory(name, ChildAccess::Traverse)
    }

    fn open_subdirectory(&self, name: &str, access: ChildAccess) -> Result<Option<Self>, String> {
        let relative = Path::new(name);
        Ok(self.open_entry(relative, access)?.map(|handle| Self {
            path: self.path.join(relative),
            handle,
        }))
    }

    fn open_entry(&self, relative: &Path, access: ChildAccess) -> Result<Option<File>, String> {
        let opened = open_directory_child(&self.handle, relative, access);
        let file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(err(error)),
        };
        if final_path_for_file(&file)? != self.path.join(relative) {
            return Err("Git path changed while it was being checked".into());
        }
        Ok(Some(file))
    }

    pub(super) fn has_entry(&self, name: &str) -> Result<bool, String> {
        Ok(self
            .open_entry(Path::new(name), ChildAccess::Read)?
            .is_some())
    }

    pub(super) fn open_file(
        &self,
        relative: &Path,
        limit: u64,
    ) -> Result<Option<(File, u64)>, String> {
        let Some(file) = self.open_entry(relative, ChildAccess::Read)? else {
            return Ok(None);
        };
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || metadata.len() > limit {
            return Err("Unsupported Git file or size limit exceeded".into());
        }
        Ok(Some((file, metadata.len())))
    }
}

/// Holds the original objects directory and the private copies for this session.
/// The repository using the staged backends must be dropped before this directory.
pub(super) struct StagedObjects {
    source: GitDirectory,
    cache: Cache,
    loose_bytes: Cell<u64>,
    pack_bytes: Cell<u64>,
}

impl StagedObjects {
    pub(super) fn new(source: GitDirectory, cache: &Path) -> Result<Self, String> {
        Ok(Self {
            source,
            cache: Cache::new(cache)?,
            loose_bytes: Cell::new(0),
            pack_bytes: Cell::new(0),
        })
    }

    pub(super) fn register_loose(&self, odb: &Odb<'_>) -> Result<(), String> {
        register_loose_backend(odb, self.cache.path())
    }

    pub(super) fn stage_pack(
        &self,
        odb: &Odb<'_>,
        oid: Oid,
        deadline: Instant,
    ) -> Result<bool, String> {
        check_deadline(deadline)?;
        let Some(source) = self.source.open_subdirectory("pack", ChildAccess::List)? else {
            return Ok(false);
        };
        let names = read_directory_names(source.handle.try_clone().map_err(err)?, MAX_PACK_ENTRIES)
            .map_err(err)?;
        for name in names {
            check_deadline(deadline)?;
            let index = Path::new(&name);
            if index.extension() != Some("idx".as_ref()) {
                continue;
            }
            let Some((mut index_file, index_size)) = source.open_file(index, MAX_PACK_BYTES)?
            else {
                continue; // Git can remove indexes during pack maintenance.
            };
            if !pack_index::contains(&mut index_file, index_size, oid, deadline)? {
                continue;
            }
            let Some((file, size)) =
                source.open_file(&index.with_extension("pack"), MAX_PACK_BYTES)?
            else {
                continue;
            };
            let used = self.pack_bytes.get();
            let pair_size = size + index_size;
            if pair_size > MAX_PACK_BYTES - used {
                return Err("Git history pack cache size limit exceeded".into());
            }
            self.cache.check_space(pair_size)?;
            index_file.rewind().map_err(err)?;
            // Use generated names. The original names and optional multi-pack
            // index are never given to libgit2.
            let staged = self.cache.path().join(format!("pack-{used}"));
            let staged_pack = staged.with_extension("pack");
            let staged_index = staged.with_extension("idx");
            copy_open_file(file, size, &staged_pack, deadline)?;
            if let Err(error) = copy_open_file(index_file, index_size, &staged_index, deadline)
                .and_then(|()| register_pack_backend(odb, &staged_index))
            {
                let _ = fs::remove_file(staged_pack);
                let _ = fs::remove_file(staged_index);
                return Err(error);
            }
            self.pack_bytes.set(used + pair_size);
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) fn verify_location(&self) -> Result<(), String> {
        self.source.verify_location()
    }

    pub(super) fn stage_loose(&self, oid: Oid, deadline: Instant) -> Result<bool, String> {
        check_deadline(deadline)?;
        let hex = oid.to_string();
        let relative = Path::new(&hex[..2]).join(&hex[2..]);
        let staged = self.cache.path().join(&relative);
        if staged.try_exists().map_err(err)? {
            return Ok(true);
        }
        let used = self.loose_bytes.get();
        let limit = MAX_LOOSE_BYTES.min(MAX_STAGED_LOOSE_BYTES - used);
        let Some((file, size)) = self.source.open_file(&relative, limit)? else {
            return Ok(false); // A packed object has no loose file.
        };
        self.cache.check_space(size)?;
        fs::create_dir_all(staged.parent().ok_or("Invalid Git object path")?).map_err(err)?;
        copy_open_file(file, size, &staged, deadline)?;
        self.loose_bytes.set(used + size);
        Ok(true)
    }
}

pub(super) fn check_deadline(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err("Git history read time limit exceeded".into());
    }
    Ok(())
}

fn copy_open_file(
    file: File,
    expected_size: u64,
    destination: &Path,
    deadline: Instant,
) -> Result<(), String> {
    use std::io::Write;
    let parent = destination.parent().ok_or("Invalid Git staging path")?;
    let mut copy = NamedTempFile::new_in(parent).map_err(err)?;
    let mut input = file.take(expected_size + 1);
    let mut buffer = [0; 64 * 1024];
    let mut copied = 0;
    loop {
        check_deadline(deadline)?;
        let count = match input.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result.map_err(err)?,
        };
        if count == 0 {
            break;
        }
        copy.write_all(&buffer[..count]).map_err(err)?;
        copied += count as u64;
    }
    if copied != expected_size {
        return Err("Git file size changed while it was being read".into());
    }
    copy.persist_noclobber(destination)
        .map_err(|error| err(error.error))?;
    Ok(())
}

fn register_loose_backend(odb: &Odb<'_>, directory: &Path) -> Result<(), String> {
    let directory = directory.into_c_string().map_err(err)?;
    let mut backend = ptr::null_mut();
    // SAFETY: The path and out pointer remain live during the call. The empty
    // ODB has initialized libgit2. This constructor only uses the given path.
    let result =
        unsafe { raw::git_odb_backend_loose(&mut backend, directory.as_ptr(), -1, 0, 0, 0) };
    if result < 0 {
        return Err(err(git2::Error::last_error(result)));
    }
    add_read_backend(odb, backend, 1)
}

fn register_pack_backend(odb: &Odb<'_>, index: &Path) -> Result<(), String> {
    let index = index.into_c_string().map_err(err)?;
    let mut backend = ptr::null_mut();
    // SAFETY: The path and out pointer remain live during the call. The empty
    // ODB has initialized libgit2. The constructor only adds this pack pair.
    let result = unsafe { raw::git_odb_backend_one_pack(&mut backend, index.as_ptr()) };
    if result < 0 {
        return Err(err(git2::Error::last_error(result)));
    }
    add_read_backend(odb, backend, 2)
}

fn add_read_backend(
    odb: &Odb<'_>,
    backend: *mut raw::git_odb_backend,
    priority: i32,
) -> Result<(), String> {
    // Adds an already constructed backend as read-only. Unlike adding a disk
    // alternate, this API never discovers more backends from the filesystem.
    // SAFETY: The caller received this owned backend from a successful
    // constructor. On success ownership transfers to the live ODB.
    let result = unsafe { raw::git_odb_add_alternate(odb.raw(), backend, priority) };
    if result < 0 {
        let error = git2::Error::last_error(result);
        // SAFETY: On failure libgit2 leaves ownership with the caller.
        unsafe {
            if let Some(free) = (*backend).free {
                free(backend);
            }
        }
        return Err(err(error));
    }
    Ok(())
}
