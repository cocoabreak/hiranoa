use std::path::{Path, PathBuf};

const INVALID_SHARE_PATH: &str = "Windowsの共有パスの形式が無効です";
const UNSUPPORTED_DEVICE_PATH: &str = "このWindowsデバイスパスは使用できません";

/// A UNC path normalized without asking Windows to resolve a file or contact a server.
#[derive(Debug)]
pub(super) struct WindowsSharePath {
    parts: Vec<String>,
}

impl WindowsSharePath {
    pub(super) fn from_input(input: &str) -> Result<Option<Self>, String> {
        if !cfg!(windows) {
            return Ok(None);
        }

        let normalized = input.trim_start().replace('/', "\\");
        if normalized.starts_with(r"\??\") {
            return Err(UNSUPPORTED_DEVICE_PATH.into());
        }
        let Some(unc) = normalized.strip_prefix(r"\\") else {
            return Ok(None);
        };
        let unc = match unc.strip_prefix("?\\").or_else(|| unc.strip_prefix(".\\")) {
            Some(device) => {
                let (prefix, rest) = device.split_once('\\').unwrap_or((device, ""));
                if prefix.eq_ignore_ascii_case("UNC") {
                    rest
                } else if is_local_volume(prefix)
                    && device.contains('\\')
                    && !rest.starts_with('\\')
                {
                    return Ok(None);
                } else {
                    return Err(UNSUPPORTED_DEVICE_PATH.into());
                }
            }
            None => unc,
        };

        let mut components = unc.split('\\');
        let server = components.next().filter(|part| valid_name(part));
        let share = components.next().filter(|part| valid_name(part));
        let (Some(server), Some(share)) = (server, share) else {
            return Err(INVALID_SHARE_PATH.into());
        };
        let mut parts = vec![server.to_owned(), share.to_owned()];
        for part in components {
            match part {
                "" | "." => {}
                ".." if parts.len() > 2 => {
                    parts.pop();
                }
                _ if valid_name(part) => parts.push(part.to_owned()),
                _ => return Err(INVALID_SHARE_PATH.into()),
            }
        }
        Ok(Some(Self { parts }))
    }

    pub(super) fn as_path(&self) -> PathBuf {
        PathBuf::from(format!(r"\\?\UNC\{}", self.parts.join("\\")))
    }

    pub(super) fn contains(&self, candidate: &Self) -> bool {
        self.parts.len() <= candidate.parts.len()
            && self
                .parts
                .iter()
                .zip(&candidate.parts)
                .enumerate()
                .all(|(index, (left, right))| {
                    if index < 2 {
                        left.eq_ignore_ascii_case(right)
                    } else {
                        // Directory and file names can be case-sensitive on an SMB server.
                        left == right
                    }
                })
    }

    pub(super) fn matches_path(&self, other: &Path) -> bool {
        other
            .to_str()
            .and_then(|path| Self::from_input(path).ok().flatten())
            .is_some_and(|other| self.parts.len() == other.parts.len() && self.contains(&other))
    }
}

fn valid_name(part: &str) -> bool {
    !part.is_empty()
        && !part.ends_with(['.', ' '])
        && !part.contains(['<', '>', ':', '"', '|', '?', '*'])
        && !part.chars().any(char::is_control)
}

fn is_local_volume(prefix: &str) -> bool {
    if matches!(prefix.as_bytes(), [letter, b':'] if letter.is_ascii_alphabetic()) {
        return true;
    }
    if !prefix
        .get(..7)
        .is_some_and(|start| start.eq_ignore_ascii_case("Volume{"))
    {
        return false;
    }
    let Some(guid) = prefix[7..].strip_suffix('}') else {
        return false;
    };
    guid.len() == 36
        && guid.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn accepts_unc_notations_and_keeps_the_volume_when_resolving_dot_segments() {
        for path in [
            r"\\fileserver\team\guide\..\notes.md",
            "//fileserver/team/./notes.md",
            r"\\?\UNC\fileserver\team\notes.md",
            r"\\.\UNC\fileserver\team\notes.md",
        ] {
            assert_eq!(
                WindowsSharePath::from_input(path)
                    .unwrap()
                    .unwrap()
                    .as_path(),
                Path::new(r"\\?\UNC\fileserver\team\notes.md")
            );
        }
    }

    #[test]
    fn rejects_malformed_shares_and_keeps_drive_paths_local() {
        for path in [
            "//fileserver",
            "//fileserver/team/../notes.md",
            "//fileserver/team/docs. /notes.md",
            "//fileserver/team/notes.md:stream",
            "//?/device",
        ] {
            assert!(WindowsSharePath::from_input(path).is_err());
        }
        for path in [
            r"C:\notes\file.md",
            r"\\?\C:\notes\file.md",
            r"\\.\C:\notes\file.md",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\notes\file.md",
        ] {
            assert!(WindowsSharePath::from_input(path).unwrap().is_none());
        }
    }
}
