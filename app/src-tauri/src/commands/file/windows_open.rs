use super::windows_share::WindowsSharePath;
use std::ffi::{OsStr, OsString};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT,
    FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{
    RtlNtStatusToDosError, GENERIC_READ, NTSTATUS, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE,
    STATUS_REPARSE_POINT_ENCOUNTERED, UNICODE_STRING,
};
use windows_sys::Win32::Storage::FileSystem::{
    QueryDosDeviceW, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, MAXIMUM_REPARSE_DATA_BUFFER_SIZE, SYNCHRONIZE,
};
use windows_sys::Win32::System::Ioctl::FSCTL_GET_REPARSE_POINT;
use windows_sys::Win32::System::SystemServices::{
    IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK,
};
use windows_sys::Win32::System::IO::{DeviceIoControl, IO_STATUS_BLOCK};

const MAX_LINKS: usize = 32;

fn unverified_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "参照先を安全に確認できません。共有フォルダーは UNC パスで指定してください",
    )
}

// Query the DOS device namespace without opening the volume. Use the returned native
// device name for the actual open, so a drive letter cannot be remapped between checks.
fn local_device(volume: &OsStr) -> io::Result<OsString> {
    let volume: Vec<_> = volume.encode_wide().chain([0]).collect();
    let mut target = [0u16; 1024];
    // SAFETY: Both buffers are live for the call; the input is NUL-terminated.
    let length =
        unsafe { QueryDosDeviceW(volume.as_ptr(), target.as_mut_ptr(), target.len() as u32) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let device = OsString::from_wide(target.split(|unit| *unit == 0).next().unwrap_or_default());
    let name = device.to_string_lossy().to_ascii_lowercase();
    let local = [
        r"\device\harddiskvolume",
        r"\device\cdrom",
        r"\device\ramdisk",
    ]
    .iter()
    .filter_map(|prefix| name.strip_prefix(prefix))
    .any(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()));
    local.then_some(device).ok_or_else(unverified_path)
}

struct OpenPath {
    root: PathBuf,
    local_device: Option<OsString>,
    components: Vec<OsString>,
}

impl OpenPath {
    fn parse(path: &Path, allow_share: bool) -> io::Result<Self> {
        let spelling = path
            .to_str()
            .ok_or_else(unverified_path)?
            .replace('/', "\\");
        let share = WindowsSharePath::from_input(&spelling)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let explicit_share = share.is_some();
        let path = match share {
            Some(share) if allow_share => share.as_path(),
            Some(_) => return Err(unverified_path()),
            None => std::path::absolute(&spelling)?,
        };
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err(unverified_path());
        };
        let local_device = match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => Some(local_device(OsStr::new(
                &format!("{}:", char::from(letter)),
            ))?),
            Prefix::Verbatim(volume) if spelling.starts_with(r"\\?\") => {
                Some(local_device(volume)?)
            }
            Prefix::VerbatimUNC(_, _) if explicit_share => None,
            _ => return Err(unverified_path()),
        };
        let mut root = PathBuf::from(prefix.as_os_str());
        root.push("\\");
        let mut names = Vec::new();
        for component in components {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::ParentDir => {
                    names.pop();
                }
                Component::Normal(name)
                    if !name.encode_wide().any(|unit| matches!(unit, 0 | 47 | 92)) =>
                {
                    names.push(name.to_owned());
                }
                _ => return Err(unverified_path()),
            }
        }
        Ok(Self {
            root,
            local_device,
            components: names,
        })
    }

    fn native_name(&self, device: &OsStr, depth: usize) -> OsString {
        let mut name = device.to_owned();
        if depth == 0 {
            name.push("\\");
        }
        for component in &self.components[..depth] {
            name.push("\\");
            name.push(component);
        }
        name
    }

    fn local_link_destination(&self, device: &OsStr) -> io::Result<PathBuf> {
        let mut parent = self.root.clone();
        for (index, component) in self.components.iter().enumerate() {
            let handle = open_native(
                None,
                &self.native_name(device, index + 1),
                FILE_READ_ATTRIBUTES,
                FILE_OPEN_REPARSE_POINT,
            )
            .map_err(status_error)?;
            if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                let (target, relative) = read_link_target(&handle)?;
                let mut destination = if relative
                    && !matches!(target.components().next(), Some(Component::Prefix(_)))
                    && !target.has_root()
                {
                    parent.join(target)
                } else if !relative && target.is_absolute() {
                    target
                } else {
                    return Err(unverified_path());
                };
                destination.extend(&self.components[index + 1..]);
                return Ok(destination);
            }
            parent.push(component);
        }
        Err(unverified_path())
    }

    fn open_share(&self, access: u32, options: u32) -> io::Result<File> {
        // Windows reparses the share root while choosing the network provider. Open
        // only that root first, then forbid reparses when opening its relative path.
        let root = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&self.root)?;
        if self.components.is_empty() {
            return if options & FILE_NON_DIRECTORY_FILE == 0 {
                Ok(root)
            } else {
                Err(io::ErrorKind::IsADirectory.into())
            };
        }
        let relative: PathBuf = self.components.iter().collect();
        open_native(Some(&root), relative.as_os_str(), access, options).map_err(status_error)
    }
}

// The caller authorizes an explicit UNC input before passing it here. A resolved link or
// a mapped drive cannot introduce another share. The kernel stops reparsing atomically.
pub(super) fn open(path: &Path, read_contents: bool) -> io::Result<File> {
    let mut path = OpenPath::parse(path, true)?;
    let (access, options) = if read_contents {
        (GENERIC_READ, FILE_NON_DIRECTORY_FILE)
    } else {
        (FILE_READ_ATTRIBUTES, 0)
    };
    for _ in 0..=MAX_LINKS {
        let Some(device) = &path.local_device else {
            return path.open_share(access, options);
        };
        match open_native(
            None,
            &path.native_name(device, path.components.len()),
            access,
            options,
        ) {
            Ok(handle) => return Ok(handle),
            Err(STATUS_REPARSE_POINT_ENCOUNTERED) => {
                path = OpenPath::parse(&path.local_link_destination(device)?, false)?;
            }
            Err(status) => return Err(status_error(status)),
        }
    }
    Err(unverified_path())
}

/// Opens scan metadata without following filesystem links, including intermediate links.
pub(super) fn open_direct(path: &Path, allow_share: bool) -> io::Result<File> {
    open_direct_with(path, allow_share, GENERIC_READ, 0)
}

pub(super) fn open_direct_attributes(path: &Path, allow_share: bool) -> io::Result<File> {
    open_direct_with(path, allow_share, FILE_READ_ATTRIBUTES, 0)
}

pub(super) fn open_scan_directory(path: &Path, list_entries: bool) -> io::Result<File> {
    use windows_sys::Wdk::Storage::FileSystem::FILE_DIRECTORY_FILE;
    use windows_sys::Win32::Storage::FileSystem::FILE_LIST_DIRECTORY;

    let access = FILE_READ_ATTRIBUTES | if list_entries { FILE_LIST_DIRECTORY } else { 0 };
    open_direct_with(path, true, access, FILE_DIRECTORY_FILE)
}

fn open_direct_with(path: &Path, allow_share: bool, access: u32, options: u32) -> io::Result<File> {
    let path = OpenPath::parse(path, allow_share)?;
    match &path.local_device {
        Some(device) => open_native(
            None,
            &path.native_name(device, path.components.len()),
            access,
            options,
        )
        .map_err(status_error),
        None => path.open_share(access, options),
    }
}

/// Opens below an existing directory handle without following reparse points.
pub(super) fn open_relative_direct(
    directory: &File,
    relative: &Path,
    mode: super::directory_scan::ChildAccess,
) -> io::Result<File> {
    use super::directory_scan::ChildAccess;
    use windows_sys::Wdk::Storage::FileSystem::FILE_DIRECTORY_FILE;
    use windows_sys::Win32::Storage::FileSystem::FILE_LIST_DIRECTORY;

    let (access, options) = match mode {
        ChildAccess::Read => (GENERIC_READ, 0),
        ChildAccess::Traverse => (FILE_READ_ATTRIBUTES, FILE_DIRECTORY_FILE),
        ChildAccess::List => (
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_DIRECTORY_FILE,
        ),
    };
    open_native(Some(directory), relative.as_os_str(), access, options).map_err(status_error)
}

pub(super) fn status_error(status: NTSTATUS) -> io::Error {
    // SAFETY: This API translates the status value without dereferencing pointers.
    io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}

fn open_native(
    root: Option<&File>,
    name: &OsStr,
    access: u32,
    options: u32,
) -> Result<File, NTSTATUS> {
    use windows_sys::Win32::Foundation::STATUS_NAME_TOO_LONG;

    let mut units: Vec<_> = name.encode_wide().collect();
    let length = u16::try_from(units.len().saturating_mul(2)).map_err(|_| STATUS_NAME_TOO_LONG)?;
    let mut name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: units.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: root.map_or(ptr::null_mut(), File::as_raw_handle),
        ObjectName: &mut name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut handle = ptr::null_mut();
    let mut status_block = IO_STATUS_BLOCK::default();
    // SAFETY: The counted UTF-16 buffer and FFI structures live through this synchronous
    // call. The successful call transfers ownership of the resulting file handle.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status_block,
            ptr::null(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            options | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(status);
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn read_link_target(file: &File) -> io::Result<(PathBuf, bool)> {
    let mut buffer = [0u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
    let mut bytes = 0;
    // SAFETY: Use the already opened reparse-point handle and an output buffer of the
    // advertised size. This queries link data, without resolving the target.
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_GET_REPARSE_POINT,
            ptr::null(),
            0,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            &mut bytes,
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let buffer = buffer.get(..bytes as usize).ok_or_else(unverified_path)?;
    let read_u16 = |offset| {
        buffer
            .get(offset..offset + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    let read_u32 = |offset| {
        buffer
            .get(offset..offset + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    // REPARSE_DATA_BUFFER uses byte offsets relative to PathBuffer.
    let (start, relative) = match read_u32(0) {
        Some(IO_REPARSE_TAG_SYMLINK) => match read_u32(16) {
            Some(0) => (20, false),
            Some(1) => (20, true),
            _ => return Err(unverified_path()),
        },
        Some(IO_REPARSE_TAG_MOUNT_POINT) => (16, false),
        _ => return Err(unverified_path()),
    };
    let offset = usize::from(read_u16(8).ok_or_else(unverified_path)?);
    let length = usize::from(read_u16(10).ok_or_else(unverified_path)?);
    if offset % 2 != 0 || length % 2 != 0 || length == 0 {
        return Err(unverified_path());
    }
    let target = buffer
        .get(start + offset..start + offset + length)
        .ok_or_else(unverified_path)?;
    let units: Vec<_> = target
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_le_bytes)
        .collect();
    let target = String::from_utf16(&units).map_err(|_| unverified_path())?;
    let target = match target.strip_prefix(r"\??\") {
        Some(tail) if !relative => PathBuf::from(format!(r"\\?\{tail}")),
        _ => PathBuf::from(target),
    };
    Ok((target, relative))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_input_can_select_a_share() {
        let path = Path::new(r"\\example\documents\notes.md");
        assert!(OpenPath::parse(path, true).unwrap().local_device.is_none());
        let Err(error) = OpenPath::parse(path, false) else {
            panic!("a resolved local link must not select a share");
        };
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }
}
