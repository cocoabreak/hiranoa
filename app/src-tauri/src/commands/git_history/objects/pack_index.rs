use super::{check_deadline, err};
use git2::Oid;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

const FANOUT_BYTES: u64 = 256 * 4;
const OID_BYTES: u64 = 20;

/// Only selects a candidate pack. libgit2 validates the staged index and pack.
pub(super) fn contains(
    file: &mut File,
    size: u64,
    oid: Oid,
    deadline: Instant,
) -> Result<bool, String> {
    let mut header = [0; 8];
    file.read_exact(&mut header).map_err(err)?;
    let (fanout_offset, entry_bytes, oid_offset, table_bytes) = if header[..4] == *b"\xfftOc" {
        if header[4..] != 2_u32.to_be_bytes() {
            return Err("Unsupported Git pack index version".into());
        }
        // Version 2 uses parallel arrays for IDs, CRCs and offsets.
        (8, OID_BYTES, 0, OID_BYTES + 8)
    } else {
        // Version 1 stores an offset and ID in each entry after the fanout.
        file.rewind().map_err(err)?;
        (0, OID_BYTES + 4, 4, OID_BYTES + 4)
    };
    let mut fanout = [0; FANOUT_BYTES as usize];
    file.read_exact(&mut fanout).map_err(err)?;
    let end_of_bucket = |byte: u8| {
        let index = usize::from(byte) * 4;
        u64::from(u32::from_be_bytes(
            fanout[index..index + 4].try_into().unwrap(),
        ))
    };
    let table = fanout_offset + FANOUT_BYTES;
    let count = end_of_bucket(u8::MAX);
    let prefix = oid.as_bytes()[0];
    let mut first = prefix.checked_sub(1).map_or(0, end_of_bucket);
    let mut end = end_of_bucket(prefix);
    if table + count * table_bytes + 2 * OID_BYTES > size || first > end || end > count {
        return Err("Invalid Git pack index".into());
    }
    while first < end {
        check_deadline(deadline)?;
        let middle = first + (end - first) / 2;
        file.seek(SeekFrom::Start(table + middle * entry_bytes + oid_offset))
            .map_err(err)?;
        let mut id = [0; OID_BYTES as usize];
        file.read_exact(&mut id).map_err(err)?;
        match id.as_slice().cmp(oid.as_bytes()) {
            std::cmp::Ordering::Equal => return Ok(true),
            std::cmp::Ordering::Less => first = middle + 1,
            std::cmp::Ordering::Greater => end = middle,
        }
    }
    Ok(false)
}
