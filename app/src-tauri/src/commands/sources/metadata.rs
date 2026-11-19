//! Bounded metadata transport; YAML interpretation is shared with the renderer.
use super::*;

const MAX_DOCUMENTS: usize = 1_000;
const MAX_SCAN_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_YAML_BYTES: usize = 16 * 1024;
const MAX_TARGETS: usize = 2_048;
const MAX_TARGET_BYTES: usize = 512 * 1024;
static METADATA_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct MetadataGuard;
impl MetadataGuard {
    fn acquire() -> Result<Self, String> {
        METADATA_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "メタデータを処理中です".to_string())
    }
}
impl Drop for MetadataGuard {
    fn drop(&mut self) {
        METADATA_IN_FLIGHT.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataCandidate {
    path: String,
    yaml: Option<String>,
    heading: Option<String>,
    incomplete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataCandidates {
    documents: Vec<MetadataCandidate>,
    source_generation: u64,
    truncated: bool,
    failed: usize,
}

fn metadata_candidate(path: String, raw: &str, prefix_truncated: bool) -> MetadataCandidate {
    let mut body = raw;
    let mut yaml = None;
    let mut incomplete = false;
    let first_line = raw.lines().next();
    if first_line == Some("---") {
        let start = raw.find('\n').map(|index| index + 1).unwrap_or(raw.len());
        let mut offset = start;
        let mut end = None;
        for line in raw[start..].split_inclusive('\n') {
            if line.trim_end_matches(['\r', '\n']) == "---" {
                end = Some((offset, offset + line.len()));
                break;
            }
            offset += line.len();
            if offset - start > MAX_YAML_BYTES {
                break;
            }
        }
        if let Some((end, body_start)) = end {
            yaml = Some(raw[start..end].to_string());
            body = &raw[body_start..];
        } else {
            incomplete = true;
            body = "";
        }
    }
    let outline = extract_safe_outline(body);
    let heading = outline
        .headings
        .into_iter()
        .find(|h| h.level == 1)
        .map(|h| h.text.chars().take(256).collect());
    incomplete |= prefix_truncated && heading.is_none();
    MetadataCandidate {
        path,
        yaml,
        heading,
        incomplete,
    }
}

fn collect_metadata(
    backend: &SourceBackend,
    source_id: &str,
    generation: u64,
    hidden: bool,
    gitignore: bool,
    roots: &AllowedRoots,
) -> Result<MetadataCandidates, String> {
    let (mut paths, mut truncated) = collect_source_markdown_paths_with_status(
        backend,
        hidden,
        gitignore && backend.capabilities().respect_gitignore,
        roots,
        MAX_ARCHIVE_ENTRIES,
    )?;
    paths.sort();
    truncated |= paths.len() > MAX_DOCUMENTS;
    let mut documents = Vec::new();
    let mut scanned = 0;
    let mut compressed = 0u64;
    let mut response_bytes = 0;
    let mut failed = 0;
    for path in paths.into_iter().take(MAX_DOCUMENTS) {
        if scanned + MAX_LINK_PREVIEW_BYTES as usize + 1 > MAX_SCAN_BYTES {
            truncated = true;
            break;
        }
        if let SourceBackend::Zip(zip) = backend {
            compressed += zip.entries.get(&path).map_or(0, |e| e.compressed_size);
            if compressed > MAX_SCAN_BYTES as u64 {
                truncated = true;
                break;
            }
        }
        let document = DocumentRef {
            source_id: source_id.to_string(),
            path: path.clone(),
        };
        let response = match backend {
            SourceBackend::Native(native) => {
                read_native_link_preview(native, &document, roots, generation)
            }
            SourceBackend::Zip(zip) => read_zip_link_preview(zip, &document, generation),
        };
        match response {
            Ok(LinkPreviewReadResponse::Ready {
                raw_prefix,
                truncated: prefix_truncated,
                ..
            }) => {
                scanned += raw_prefix.len();
                let candidate = metadata_candidate(path, &raw_prefix, prefix_truncated);
                response_bytes += serde_json::to_vec(&candidate)
                    .map_err(|_| "メタデータを変換できませんでした".to_string())?
                    .len()
                    + 1;
                if response_bytes > MAX_RESPONSE_BYTES - 512 {
                    truncated = true;
                    break;
                }
                documents.push(candidate);
            }
            _ => {
                failed += 1;
                scanned += MAX_LINK_PREVIEW_BYTES as usize + 1;
            }
        }
    }
    Ok(MetadataCandidates {
        documents,
        source_generation: generation,
        truncated,
        failed,
    })
}

#[tauri::command]
pub async fn get_source_metadata_candidates(
    source_id: String,
    show_hidden_files: bool,
    respect_gitignore: bool,
    roots: State<'_, AllowedRoots>,
    registry: State<'_, SourceRegistry>,
) -> Result<MetadataCandidates, String> {
    let roots = roots.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MetadataGuard::acquire()?;
        let (backend, generation) = registry.get_with_generation(&source_id)?;
        if let SourceBackend::Zip(zip) = backend.as_ref() {
            roots.resolve(&zip.archive_path.to_string_lossy())?;
        }
        collect_metadata(
            &backend,
            &source_id,
            generation,
            show_hidden_files,
            respect_gitignore,
            &roots,
        )
    })
    .await
    .map_err(|_| "メタデータの取得に失敗しました".to_string())?
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetadataTarget {
    path: String,
    target: Option<String>,
    status: &'static str,
}

fn inspect_target(backend: &SourceBackend, path: String, roots: &AllowedRoots) -> MetadataTarget {
    let mut result = MetadataTarget {
        path: path.clone(),
        target: None,
        status: "unverifiable",
    };
    let Ok(normalized) = normalize_virtual_path(&path) else {
        result.status = "outsideSource";
        return result;
    };
    if let SourceBackend::Native(native) = backend {
        let candidate = native.root.join(&normalized);
        if roots
            .inspect_share_checked_path(&candidate.to_string_lossy())
            .is_ok_and(|found| found.is_some_and(|(path, _)| !path.starts_with(&native.root)))
        {
            result.status = "outsideSource";
            return result;
        }
    }
    let Ok(resolved) = resolve_directory_index(backend, &normalized, roots) else {
        return result;
    };
    if !is_markdown_virtual_path(&resolved) {
        result.status = "unsupported";
        return result;
    }
    match backend {
        SourceBackend::Native(native) => {
            let candidate = native.root.join(&resolved);
            match roots.inspect_share_checked_path(&candidate.to_string_lossy()) {
                Ok(None) => result.status = "missing",
                Err(_) => {}
                Ok(Some((canonical, _))) => {
                    if canonical.starts_with(&native.root) {
                        if let Ok((file, final_path)) =
                            crate::commands::file::trusted_paths::open_allowed_file(
                                roots,
                                &candidate.to_string_lossy(),
                            )
                        {
                            if !final_path.starts_with(&native.root) {
                                result.status = "outsideSource";
                            } else if file.metadata().is_ok_and(|m| m.is_file())
                                && crate::commands::has_markdown_extension(&final_path)
                            {
                                result.status = "ready";
                                result.target = Some(resolved);
                            }
                        }
                    } else {
                        result.status = "outsideSource";
                    }
                }
            }
        }
        SourceBackend::Zip(zip) => {
            if zip
                .entries
                .get(&resolved)
                .is_some_and(|e| e.kind == ZipEntryKind::File)
            {
                result.status = "ready";
                result.target = Some(resolved);
            } else {
                result.status = "missing";
            }
        }
    }
    result
}

#[tauri::command]
pub async fn inspect_source_metadata_targets(
    source_id: String,
    paths: Vec<String>,
    roots: State<'_, AllowedRoots>,
    registry: State<'_, SourceRegistry>,
) -> Result<Vec<MetadataTarget>, String> {
    if paths.len() > MAX_TARGETS
        || paths.iter().any(|p| p.len() > MAX_VIRTUAL_PATH_BYTES)
        || paths.iter().map(String::len).sum::<usize>() > MAX_TARGET_BYTES
    {
        return Err("出典の検証上限を超えています".to_string());
    }
    let roots = roots.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MetadataGuard::acquire()?;
        let backend = registry.get(&source_id)?;
        if let SourceBackend::Zip(zip) = backend.as_ref() {
            roots.resolve(&zip.archive_path.to_string_lossy())?;
        }
        Ok(paths
            .into_iter()
            .map(|path| inspect_target(&backend, path, &roots))
            .collect())
    })
    .await
    .map_err(|_| "出典の検証に失敗しました".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn extracts_only_yaml_and_first_h1_with_crlf_and_code_fences() {
        let candidate = metadata_candidate(
            "note.md".into(),
            "---\r\ntitle: hello\r\n---\r\n```\n# fake\n```\n# Real\nPrivate body",
            false,
        );
        assert_eq!(candidate.yaml.as_deref(), Some("title: hello\r\n"));
        assert_eq!(candidate.heading.as_deref(), Some("Real"));
        assert!(!candidate.incomplete);
        let encoded = serde_json::to_string(&candidate).unwrap();
        assert!(!encoded.contains("Private body"));
    }
    #[test]
    fn oversized_or_unclosed_frontmatter_is_reported() {
        let raw = format!("---\nvalue: {}\n---\n# Body", "x".repeat(MAX_YAML_BYTES));
        assert!(metadata_candidate("note.md".into(), &raw, false).incomplete);
        assert!(metadata_candidate("note.md".into(), "---\nx: 1", true).incomplete);
    }
    #[test]
    fn zip_catalog_and_targets_use_only_the_authorized_archive() {
        let directory = tempfile::tempdir().unwrap();
        let archive_path = directory.path().join("docs.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive_path).unwrap());
        for (name, body) in [
            (
                "silver/note.md",
                "---\nsources: [../bronze/index.md]\n---\n# Silver",
            ),
            ("bronze/index.md", "# Original"),
            (".hidden.md", "# Hidden"),
        ] {
            writer
                .start_file(
                    name,
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
        let roots = AllowedRoots::new();
        roots
            .register_zip_file(&archive_path.to_string_lossy())
            .unwrap();
        let backend = SourceBackend::Zip(
            build_zip_source(
                roots.resolve(&archive_path.to_string_lossy()).unwrap(),
                &roots,
            )
            .unwrap(),
        );
        let catalog = collect_metadata(&backend, "zip", 0, false, false, &roots).unwrap();
        assert_eq!(catalog.documents.len(), 2);
        assert_eq!(catalog.documents[1].heading.as_deref(), Some("Silver"));
        assert!(!catalog.truncated);
        assert_eq!(
            inspect_target(&backend, "bronze".into(), &roots)
                .target
                .as_deref(),
            Some("bronze/index.md")
        );
        assert_eq!(
            inspect_target(&backend, "missing.md".into(), &roots).status,
            "missing"
        );
        assert!(roots
            .resolve(&directory.path().join("secret.md").to_string_lossy())
            .is_err());
    }
    #[test]
    fn native_catalog_reports_document_limit_and_never_returns_body_text() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..MAX_DOCUMENTS + 1 {
            std::fs::write(
                directory.path().join(format!("{index:04}.md")),
                "# Heading\nSECRET_BODY",
            )
            .unwrap();
        }
        let roots = AllowedRoots::new();
        roots.register(&directory.path().to_string_lossy()).unwrap();
        let backend = SourceBackend::Native(NativeSource::from_fixture(directory.path(), &roots));
        let catalog = collect_metadata(&backend, "native", 0, false, false, &roots).unwrap();
        assert_eq!(catalog.documents.len(), MAX_DOCUMENTS);
        assert!(catalog.truncated);
        assert!(!serde_json::to_string(&catalog)
            .unwrap()
            .contains("SECRET_BODY"));
    }
    #[test]
    fn native_targets_preserve_source_boundary_and_distinguish_missing_and_unsupported() {
        let directory = tempfile::tempdir().unwrap();
        let roots = AllowedRoots::new();
        roots.register(&directory.path().to_string_lossy()).unwrap();
        let native = NativeSource::from_fixture(directory.path(), &roots);
        std::fs::write(directory.path().join("note.md"), "# Note").unwrap();
        let backend = SourceBackend::Native(native);
        assert_eq!(
            inspect_target(&backend, "note.md".into(), &roots).status,
            "ready"
        );
        assert_eq!(
            inspect_target(&backend, "missing.md".into(), &roots).status,
            "missing"
        );
        assert_eq!(
            inspect_target(&backend, "file.pdf".into(), &roots).status,
            "unsupported"
        );
        assert_eq!(
            inspect_target(&backend, "../outside.md".into(), &roots).status,
            "outsideSource"
        );
        let catalog = collect_metadata(&backend, "test", 1, false, false, &roots).unwrap();
        assert_eq!(catalog.documents.len(), 1);
        assert_eq!(catalog.source_generation, 1);
    }
}
