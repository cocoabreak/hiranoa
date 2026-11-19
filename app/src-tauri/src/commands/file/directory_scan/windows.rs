use super::{DirectoryEntry, EntryKind};
use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::mem::{offset_of, size_of_val};
use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
use std::ptr;
use windows_sys::Wdk::Storage::FileSystem::{
    FileDirectoryInformation, NtQueryDirectoryFile, FILE_DIRECTORY_INFORMATION,
};
use windows_sys::Win32::Foundation::{STATUS_NO_MORE_FILES, STATUS_NO_SUCH_FILE, STATUS_SUCCESS};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_REPARSE_POINT,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

pub(super) struct DirectoryReader {
    handle: File,
    // FILE_DIRECTORY_INFORMATION requires eight-byte alignment.
    buffer: Box<[u64; 1024]>,
    next: usize,
    end: usize,
}

impl DirectoryReader {
    pub(super) fn new(handle: File) -> io::Result<Self> {
        Ok(Self {
            handle,
            buffer: Box::new([0; 1024]),
            next: 0,
            end: 0,
        })
    }

    pub(super) fn handle(&self) -> &File {
        &self.handle
    }

    pub(super) fn next_entry(&mut self) -> io::Result<Option<DirectoryEntry>> {
        if self.next == self.end && !self.refill()? {
            return Ok(None);
        }
        // SAFETY: refill checked that end is within the live, initialized buffer.
        let bytes =
            unsafe { std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), self.end) };
        let (entry, consumed) = parse_entry(&bytes[self.next..])?;
        self.next += consumed;
        Ok(Some(entry))
    }

    fn refill(&mut self) -> io::Result<bool> {
        let mut io_status = IO_STATUS_BLOCK::default();
        let len = size_of_val(&*self.buffer);
        // SAFETY: The directory is held open synchronously, and both output buffers
        // are live, writable and aligned for the entire kernel call.
        let status = unsafe {
            NtQueryDirectoryFile(
                self.handle.as_raw_handle(),
                ptr::null_mut(),
                None,
                ptr::null(),
                &mut io_status,
                self.buffer.as_mut_ptr().cast(),
                len as u32,
                FileDirectoryInformation,
                false,
                ptr::null(),
                false,
            )
        };
        match status {
            STATUS_NO_MORE_FILES | STATUS_NO_SUCH_FILE => Ok(false),
            STATUS_SUCCESS if (1..=len).contains(&io_status.Information) => {
                self.next = 0;
                self.end = io_status.Information;
                Ok(true)
            }
            STATUS_SUCCESS => Err(invalid_entry()),
            _ => Err(super::super::windows_open::status_error(status)),
        }
    }
}

fn invalid_entry() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

fn parse_entry(bytes: &[u8]) -> io::Result<(DirectoryEntry, usize)> {
    const HEADER: usize = offset_of!(FILE_DIRECTORY_INFORMATION, FileName);
    let read_u32 = |offset: usize| {
        bytes
            .get(offset..offset + 4)
            .and_then(|part| part.try_into().ok())
            .map(u32::from_le_bytes)
            .ok_or_else(invalid_entry)
    };
    let next = read_u32(offset_of!(FILE_DIRECTORY_INFORMATION, NextEntryOffset))? as usize;
    let attributes = read_u32(offset_of!(FILE_DIRECTORY_INFORMATION, FileAttributes))?;
    let name_len = read_u32(offset_of!(FILE_DIRECTORY_INFORMATION, FileNameLength))? as usize;
    let consumed = if next == 0 { bytes.len() } else { next };
    if name_len == 0 || !name_len.is_multiple_of(2) || (next != 0 && !next.is_multiple_of(8)) {
        return Err(invalid_entry());
    }
    let end = HEADER.checked_add(name_len).ok_or_else(invalid_entry)?;
    let name = bytes
        .get(..consumed)
        .and_then(|record| record.get(HEADER..end))
        .ok_or_else(invalid_entry)?;
    let units: Vec<_> = name
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(u16::from_le_bytes)
        .collect();
    let kind = if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        EntryKind::Other
    } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        EntryKind::Directory
    } else {
        EntryKind::File
    };
    Ok((
        DirectoryEntry {
            name: OsString::from_wide(&units),
            kind,
            hidden: attributes & FILE_ATTRIBUTE_HIDDEN != 0,
        },
        consumed,
    ))
}
