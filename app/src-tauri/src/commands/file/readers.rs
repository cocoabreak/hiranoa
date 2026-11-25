use super::ignore_rules::walk_entries;
use super::safe_outline::{extract_safe_outline, SafeOutlineHeading};
use super::trusted_paths::{open_allowed_file, AllowedRoots};
use crate::commands::has_markdown_extension;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use tauri::State;

const MAX_CUSTOM_CSS_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
pub(super) const LARGE_MARKDOWN_WARNING_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const UNSUPPORTED_IMAGE_FORMAT: &str = "対応していない画像形式です";
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PathStat {
    pub is_dir: bool,
    pub is_file: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFileContent {
    pub raw: String,
    pub byte_size: u64,
    pub requires_confirmation: bool,
    pub safe_outline: Vec<SafeOutlineHeading>,
    pub safe_outline_truncated: bool,
}

#[tauri::command(async)]
pub fn stat_path(path: String, state: State<'_, AllowedRoots>) -> Option<PathStat> {
    let (_, metadata) = state.inspect_allowed_path(&path).ok()??;
    Some(PathStat {
        is_dir: metadata.is_dir(),
        is_file: metadata.is_file(),
    })
}

/// ファイル内容をUTF-8文字列で返す（信頼済みルート配下に限る）
#[tauri::command(async)]
pub fn read_file(
    path: String,
    state: State<'_, AllowedRoots>,
) -> Result<MarkdownFileContent, String> {
    let (raw, byte_size) = read_file_with_size_inner(&state, &path)?;
    Ok(build_markdown_content(raw, byte_size))
}

pub(crate) fn build_markdown_content(raw: String, byte_size: u64) -> MarkdownFileContent {
    let requires_confirmation = requires_large_markdown_confirmation(byte_size);
    // 大容量セーフモードに加え、通常文書の読み取り専用ソース表示でも
    // HTMLを生成せずTOCを利用できるよう、常に上限付きアウトラインを返す。
    let safe_outline = extract_safe_outline(&raw);
    MarkdownFileContent {
        raw,
        byte_size,
        requires_confirmation,
        safe_outline: safe_outline.headings,
        safe_outline_truncated: safe_outline.truncated,
    }
}

#[cfg(test)]
pub(super) fn read_file_inner(state: &AllowedRoots, path: &str) -> Result<String, String> {
    read_file_with_size_inner(state, path).map(|(raw, _)| raw)
}

pub(super) fn read_file_with_size_inner(
    state: &AllowedRoots,
    path: &str,
) -> Result<(String, u64), String> {
    let (file, canonical) = open_allowed_file(state, path)?;
    if !has_markdown_extension(&canonical) {
        return Err("Markdownファイル（.md / .markdown）のみ読み込めます".to_string());
    }

    let byte_size = file
        .metadata()
        .map_err(|e| format!("ファイル情報の取得に失敗しました: {}", e))?
        .len();
    if byte_size > MAX_MARKDOWN_BYTES {
        return Err("Markdownファイルは10MiB以下にしてください".to_string());
    }

    let mut raw = String::new();
    file.take(MAX_MARKDOWN_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|e| format!("ファイル読み込みエラー: {}", e))?;
    if raw.len() as u64 > MAX_MARKDOWN_BYTES {
        return Err("Markdownファイルは10MiB以下にしてください".to_string());
    }
    let observed_size = observed_markdown_size(byte_size, raw.len());
    Ok((raw, observed_size))
}

pub(super) fn requires_large_markdown_confirmation(byte_size: u64) -> bool {
    byte_size >= LARGE_MARKDOWN_WARNING_BYTES
}

pub(super) fn observed_markdown_size(metadata_size: u64, bytes_read: usize) -> u64 {
    metadata_size.max(bytes_read as u64)
}

/// 信頼済みルート配下のカスタムCSSをUTF-8文字列として返す。
/// 任意ファイル読み取りへの転用を防ぐため、拡張子とサイズを専用に制限する。
#[tauri::command(async)]
pub fn read_custom_css(path: String, state: State<'_, AllowedRoots>) -> Result<String, String> {
    read_custom_css_inner(&state, &path)
}

pub(super) fn read_custom_css_inner(state: &AllowedRoots, path: &str) -> Result<String, String> {
    let (file, canonical) = open_allowed_file(state, path)?;
    if !canonical
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("css"))
    {
        return Err("CSSファイル（.css）を選択してください".to_string());
    }
    let metadata = file
        .metadata()
        .map_err(|e| format!("CSSファイル情報の取得に失敗しました: {}", e))?;
    if metadata.len() > MAX_CUSTOM_CSS_BYTES {
        return Err("CSSファイルは1MiB以下にしてください".to_string());
    }
    let mut raw = String::new();
    file.take(MAX_CUSTOM_CSS_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|e| format!("CSSファイル読み込みエラー: {}", e))?;
    if raw.len() as u64 > MAX_CUSTOM_CSS_BYTES {
        return Err("CSSファイルは1MiB以下にしてください".to_string());
    }
    Ok(raw)
}

pub(crate) fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

pub(crate) fn native_image_mime_type(path: &Path) -> Option<&'static str> {
    // Exclude Windows named streams before inspecting the image extension.
    #[cfg(windows)]
    if path.file_name()?.as_encoded_bytes().contains(&b':') {
        return None;
    }
    image_mime_type(path)
}

/// 信頼済みルート配下にあることを検証した上で画像をbase64データURLとして返す
#[tauri::command(async)]
pub fn read_image_data_url(path: String, state: State<'_, AllowedRoots>) -> Result<String, String> {
    read_image_data_url_inner(&state, &path)
}

pub(super) fn read_image_data_url_inner(
    state: &AllowedRoots,
    path: &str,
) -> Result<String, String> {
    let (file, final_path) = open_allowed_file(state, path)?;
    read_opened_image(file, &final_path)
}

pub(crate) fn read_opened_image(file: File, final_path: &Path) -> Result<String, String> {
    let mime = native_image_mime_type(final_path).ok_or(UNSUPPORTED_IMAGE_FORMAT)?;
    if file
        .metadata()
        .map_err(|e| format!("画像ファイル情報の取得に失敗しました: {}", e))?
        .len()
        > MAX_IMAGE_BYTES
    {
        return Err("画像ファイルは20MiB以下にしてください".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("画像読み込みエラー: {}", e))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("画像ファイルは20MiB以下にしてください".to_string());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// ディレクトリ直下1階層のFileEntryを返す（信頼済みルート配下に限る）。
/// サブフォルダの中身はフロントエンドが展開時に本コマンドを再度呼んで遅延取得する。
/// respect_gitignoreが真の場合、.gitignore等で無視されるエントリを除外する。
#[tauri::command(async)]
pub fn read_directory(
    path: String,
    respect_gitignore: bool,
    state: State<'_, AllowedRoots>,
) -> Result<Vec<FileEntry>, String> {
    let canonical = state.resolve(&path)?;
    Ok(read_dir_single_level(&canonical, respect_gitignore, &state))
}

/// ディレクトリ直下1階層を走査してFileEntryのリストを返す。
/// ファイルは表示対象拡張子（MARKDOWN_EXTENSIONS）のみ含め、ディレクトリは常に含める
/// （中身は展開時に遅延取得するため、この時点では表示対象の有無を判定できない）。
/// children は常にNone（未取得）とし、読めないエントリは黙ってスキップする。
pub(crate) fn read_dir_single_level(
    path: &Path,
    respect_gitignore: bool,
    roots: &AllowedRoots,
) -> Vec<FileEntry> {
    let mut entries = Vec::new();

    // 隠しファイルの表示可否はフロントエンドで切り替える。
    let walk = walk_entries(path, roots, true, respect_gitignore, Some(1));
    for entry in walk.flatten().take(MAX_DIRECTORY_ENTRIES) {
        // depth 0 は走査起点のディレクトリ自身なのでスキップ
        if entry.depth() == 0 {
            continue;
        }
        if roots.resolve(&entry.path().to_string_lossy()).is_err() {
            continue;
        }
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if !is_dir && !has_markdown_extension(entry.path()) {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_hidden = file_name.starts_with('.');
        // フロントエンドとの一貫性のためスラッシュに正規化
        let entry_path = normalize_path_for_frontend(entry.path());

        entries.push(FileEntry {
            name: file_name,
            path: entry_path,
            is_dir,
            is_hidden,
            children: None,
        });
    }

    // ディレクトリ優先、その中でアルファベット順（大小文字無視）
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    entries
}

pub(crate) fn normalize_path_for_display(path: &Path) -> String {
    let raw = path.to_string_lossy();

    #[cfg(windows)]
    {
        raw.strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{}", rest))
            .or_else(|| raw.strip_prefix(r"\\?\").map(String::from))
            .unwrap_or_else(|| raw.into_owned())
    }

    #[cfg(not(windows))]
    {
        raw.into_owned()
    }
}

pub(crate) fn normalize_path_for_frontend(path: &Path) -> String {
    normalize_path_for_display(path).replace('\\', "/")
}
