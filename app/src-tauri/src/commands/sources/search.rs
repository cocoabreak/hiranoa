use super::{
    collect_source_markdown_paths_with_status, read_source_text, DocumentRef, SourceBackend,
    SourceRegistry, MAX_ARCHIVE_ENTRIES, MAX_SEARCH_TOTAL_BYTES, MAX_SEARCH_TOTAL_COMPRESSED_BYTES,
};
use crate::commands::file::AllowedRoots;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::State;

const MAX_SEARCH_RESULTS: usize = 1_000;
const MAX_MATCHES_PER_FILE: usize = 1_000;
const MAX_TOTAL_MATCHES: usize = 5_000;
const MAX_LINE_PREVIEW_CHARS: usize = 100;

#[derive(Debug, Serialize)]
pub struct SearchMatch {
    pub(crate) line_number: usize,
    pub(crate) line_text: String,
}

#[derive(Clone)]
pub struct SearchState(Arc<AtomicU64>);

impl SearchState {
    pub fn new() -> Self {
        Self(Arc::new(AtomicU64::new(0)))
    }

    pub(crate) fn begin(&self, request_id: u64) {
        self.0.fetch_max(request_id, Ordering::SeqCst);
    }

    pub(crate) fn is_current(&self, request_id: u64) -> bool {
        self.0.load(Ordering::SeqCst) == request_id
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSearchOptions {
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    show_hidden_files: bool,
    respect_gitignore: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSearchResult {
    document: DocumentRef,
    file_path: String,
    matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize)]
pub struct SourceSearchResponse {
    results: Vec<SourceSearchResult>,
    truncated: bool,
    cancelled: bool,
}

fn truncate_search_preview(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() > MAX_LINE_PREVIEW_CHARS {
        format!(
            "{}...",
            trimmed
                .chars()
                .take(MAX_LINE_PREVIEW_CHARS)
                .collect::<String>()
        )
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn search_source(
    request_id: u64,
    source_id: String,
    options: SourceSearchOptions,
    roots: State<'_, AllowedRoots>,
    registry: State<'_, SourceRegistry>,
    searches: State<'_, SearchState>,
) -> Result<SourceSearchResponse, String> {
    let roots = roots.inner().clone();
    let registry = registry.inner().clone();
    let searches = searches.inner().clone();
    searches.begin(request_id);

    tauri::async_runtime::spawn_blocking(move || {
        let backend = registry.get(&source_id)?;
        search_documents(
            &backend,
            &source_id,
            options,
            &roots,
            MAX_ARCHIVE_ENTRIES,
            || !searches.is_current(request_id),
        )
    })
    .await
    .map_err(|error| format!("検索処理に失敗しました: {error}"))?
}

fn search_documents(
    backend: &SourceBackend,
    source_id: &str,
    options: SourceSearchOptions,
    roots: &AllowedRoots,
    entry_limit: usize,
    is_cancelled: impl Fn() -> bool,
) -> Result<SourceSearchResponse, String> {
    if options.query.is_empty() || is_cancelled() {
        return Ok(SourceSearchResponse {
            results: Vec::new(),
            truncated: false,
            cancelled: is_cancelled(),
        });
    }
    let pattern = if options.is_regex {
        options.query
    } else {
        regex::escape(&options.query)
    };
    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| error.to_string())?;
    let (paths, mut truncated) = collect_source_markdown_paths_with_status(
        backend,
        options.show_hidden_files,
        options.respect_gitignore && backend.capabilities().respect_gitignore,
        roots,
        entry_limit,
    )?;
    let mut results = Vec::new();
    let mut total_matches = 0usize;
    let mut total_bytes = 0usize;
    let mut total_compressed_bytes = 0u64;
    // ZIPは検索全体で同じファイルハンドルと中央ディレクトリを再利用する。
    // エントリごとの再オープンは最大10,000回の中央ディレクトリ再解析になるため避ける。
    let mut zip_archive = match backend {
        SourceBackend::Zip(source) => Some(
            source
                .archive
                .lock()
                .map_err(|_| "ZIPアーカイブのロックに失敗しました".to_string())?,
        ),
        SourceBackend::Native(_) => None,
    };
    for path in paths {
        if is_cancelled() {
            return Ok(SourceSearchResponse {
                results,
                truncated,
                cancelled: true,
            });
        }
        if results.len() >= MAX_SEARCH_RESULTS {
            truncated = true;
            break;
        }
        if let SourceBackend::Zip(source) = backend {
            let compressed_size = source
                .entries
                .get(&path)
                .map(|entry| entry.compressed_size)
                .unwrap_or_default();
            total_compressed_bytes = total_compressed_bytes.saturating_add(compressed_size);
            if total_compressed_bytes > MAX_SEARCH_TOTAL_COMPRESSED_BYTES {
                truncated = true;
                break;
            }
        }
        let raw = match read_source_text(backend, &path, roots, zip_archive.as_deref_mut()) {
            Ok(raw) => raw,
            Err(_) if matches!(backend, SourceBackend::Native(_)) => continue,
            Err(error) => return Err(error),
        };
        total_bytes = total_bytes.saturating_add(raw.len());
        if total_bytes > MAX_SEARCH_TOTAL_BYTES {
            truncated = true;
            break;
        }
        let mut matches = Vec::new();
        for (line_index, line) in raw.lines().enumerate() {
            if regex.is_match(line) {
                matches.push(SearchMatch {
                    line_number: line_index + 1,
                    line_text: truncate_search_preview(line),
                });
                total_matches += 1;
                if matches.len() >= MAX_MATCHES_PER_FILE || total_matches >= MAX_TOTAL_MATCHES {
                    truncated = true;
                    break;
                }
            }
        }
        if !matches.is_empty() {
            results.push(SourceSearchResult {
                document: DocumentRef {
                    source_id: source_id.to_owned(),
                    path: path.clone(),
                },
                file_path: path,
                matches,
            });
        }
        if total_matches >= MAX_TOTAL_MATCHES {
            break;
        }
    }
    results.sort_by(|left, right| left.file_path.cmp(&right.file_path));
    Ok(SourceSearchResponse {
        results,
        truncated,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sources::NativeSource;
    use std::fs;

    fn options(query: &str, respect_gitignore: bool) -> SourceSearchOptions {
        SourceSearchOptions {
            query: query.into(),
            is_regex: false,
            case_sensitive: false,
            show_hidden_files: false,
            respect_gitignore,
        }
    }

    #[test]
    fn source_search_filters_files_and_reports_line_numbers_and_limited_previews() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path();
        fs::create_dir(path.join(".git")).unwrap();
        fs::write(path.join(".gitignore"), "draft.md\n").unwrap();
        fs::write(path.join("draft.md"), "needle").unwrap();
        fs::write(path.join("skip.txt"), "needle").unwrap();
        fs::write(
            path.join("notes.markdown"),
            format!("first\n NEEDLE{} ", "あ".repeat(120)),
        )
        .unwrap();
        let roots = AllowedRoots::new();
        roots.register(&path.to_string_lossy()).unwrap();
        let backend = SourceBackend::Native(NativeSource::from_fixture(path, &roots));
        let run = |ignore| {
            search_documents(
                &backend,
                "notes",
                options("needle", ignore),
                &roots,
                MAX_ARCHIVE_ENTRIES,
                || false,
            )
            .unwrap()
        };
        let result = run(true);
        assert!(!result.truncated && !result.cancelled);
        assert_eq!(result.results.len(), 1);
        let file = &result.results[0];
        assert_eq!(file.file_path, "notes.markdown");
        assert_eq!(file.document.source_id, "notes");
        assert_eq!(file.matches[0].line_number, 2);
        assert_eq!(
            file.matches[0].line_text,
            format!("NEEDLE{}...", "あ".repeat(MAX_LINE_PREVIEW_CHARS - 6))
        );
        assert_eq!(run(false).results.len(), 2);
    }

    #[test]
    fn source_search_distinguishes_cancelled_truncated_and_complete_empty_results() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("a.md"), "other").unwrap();
        let roots = AllowedRoots::new();
        roots.register(&folder.path().to_string_lossy()).unwrap();
        let backend = SourceBackend::Native(NativeSource::from_fixture(folder.path(), &roots));
        let run = |limit, cancelled| {
            search_documents(
                &backend,
                "notes",
                options("needle", false),
                &roots,
                limit,
                || cancelled,
            )
            .unwrap()
        };
        let partial = run(1, false);
        assert!(partial.results.is_empty() && partial.truncated && !partial.cancelled);
        let complete = run(2, false);
        assert!(complete.results.is_empty() && !complete.truncated && !complete.cancelled);
        let cancelled = run(2, true);
        assert!(cancelled.results.is_empty() && cancelled.cancelled);
        assert!(search_documents(
            &backend,
            "notes",
            options("needle", false),
            &AllowedRoots::new(),
            2,
            || false
        )
        .is_err());
    }
}
