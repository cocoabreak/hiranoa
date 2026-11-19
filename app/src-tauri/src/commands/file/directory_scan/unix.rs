use super::{ChildAccess, DirectoryEntry, DirectoryHandle, EntryKind};
use crate::commands::file::trusted_paths::unix_traversal_flags;
use std::ffi::{CStr, CString, OsString};
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, IntoRawFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path};
use std::ptr::NonNull;

pub(super) fn open_relative_direct(
    directory: DirectoryHandle<'_>,
    relative: &Path,
    access: ChildAccess,
) -> io::Result<File> {
    let mut parts = relative.components().peekable();
    let mut current = None::<File>;
    while let Some(Component::Normal(part)) = parts.next() {
        let name = CString::new(part.as_bytes())?;
        let mode = if parts.peek().is_some() {
            ChildAccess::Traverse
        } else {
            access
        };
        let flags = match mode {
            ChildAccess::Read => libc::O_RDONLY,
            ChildAccess::Traverse => unix_traversal_flags(),
            ChildAccess::List => libc::O_RDONLY | libc::O_DIRECTORY,
        } | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK;
        let parent = current.as_ref().map_or(directory, File::as_fd);
        // SAFETY: parent owns a live descriptor and name is NUL-terminated.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: openat returned a new descriptor owned by this caller.
        current = Some(unsafe { File::from_raw_fd(fd) });
        if parts.peek().is_none() {
            return Ok(current.unwrap());
        }
    }
    Err(io::ErrorKind::InvalidInput.into())
}

pub(super) struct DirectoryReader {
    stream: NonNull<libc::DIR>,
    descriptor: RawFd,
}

impl DirectoryReader {
    pub(super) fn new(handle: File) -> io::Result<Self> {
        // SAFETY: fdopendir accepts ownership of the live descriptor on success.
        let stream = NonNull::new(unsafe { libc::fdopendir(handle.as_raw_fd()) })
            .ok_or_else(io::Error::last_os_error)?;
        let descriptor = handle.into_raw_fd();
        Ok(Self { stream, descriptor })
    }

    pub(super) fn handle(&self) -> DirectoryHandle<'_> {
        // SAFETY: stream keeps this descriptor open for the lifetime of self.
        unsafe { BorrowedFd::borrow_raw(self.descriptor) }
    }

    pub(super) fn next_entry(&mut self) -> io::Result<Option<DirectoryEntry>> {
        // SAFETY: errno is local to this thread and the stream is exclusively
        // borrowed. The entry remains live until the next read of this stream.
        unsafe {
            let errno = errno_ptr();
            *errno = 0;
            let entry = libc::readdir(self.stream.as_ptr());
            if entry.is_null() {
                return if *errno == 0 {
                    Ok(None)
                } else {
                    Err(io::Error::last_os_error())
                };
            }
            // Read only the fields and terminated name inside the variable-size record.
            let record_len = std::ptr::addr_of!((*entry).d_reclen).read() as usize;
            let name_len = record_len
                .checked_sub(std::mem::offset_of!(libc::dirent, d_name))
                .ok_or(io::ErrorKind::InvalidData)?;
            let name_ptr = std::ptr::addr_of!((*entry).d_name).cast::<u8>();
            let terminator = (0..name_len)
                .find(|offset| name_ptr.add(*offset).read() == 0)
                .ok_or(io::ErrorKind::InvalidData)?;
            let name = CStr::from_bytes_with_nul_unchecked(std::slice::from_raw_parts(
                name_ptr,
                terminator + 1,
            ));
            let kind = match std::ptr::addr_of!((*entry).d_type).read() {
                libc::DT_DIR => EntryKind::Directory,
                libc::DT_REG => EntryKind::File,
                libc::DT_UNKNOWN
                    if !matches!(name.to_bytes(), b"." | b"..")
                        && !name.to_bytes().contains(&b'/') =>
                {
                    self.entry_kind(name)
                }
                _ => EntryKind::Other,
            };
            Ok(Some(DirectoryEntry {
                name: OsString::from_vec(name.to_bytes().to_vec()),
                kind,
                hidden: false,
            }))
        }
    }

    fn entry_kind(&self, name: &CStr) -> EntryKind {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: The name and output buffer live through fstatat. The descriptor
        // is the enumerated parent, and AT_SYMLINK_NOFOLLOW prevents dereference.
        let status = unsafe {
            libc::fstatat(
                self.descriptor,
                name.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if status != 0 {
            return EntryKind::Other;
        }
        // SAFETY: Successful fstatat filled the stat buffer.
        match unsafe { stat.assume_init() }.st_mode & libc::S_IFMT {
            libc::S_IFDIR => EntryKind::Directory,
            libc::S_IFREG => EntryKind::File,
            _ => EntryKind::Other,
        }
    }
}

impl Drop for DirectoryReader {
    fn drop(&mut self) {
        // SAFETY: This stream is exclusively owned and closed exactly once.
        unsafe { libc::closedir(self.stream.as_ptr()) };
    }
}

unsafe fn errno_ptr() -> *mut libc::c_int {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        libc::__error()
    }
}
