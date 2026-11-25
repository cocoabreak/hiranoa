# Changelog

All notable changes to Hiranoa (formerly FeatherMD) are documented in this file.

## [0.3.8] - 2026-11-25

### Added

- Select text in a Markdown document to highlight it in one of three colors or add a reading note. The annotations panel keeps the original quote and note available after edits, so readers can reattach a highlight when its position is unclear.
- Export and import a document's annotations as JSON, or copy or move them to another document. Annotations are stored locally in Hiranoa, including for documents opened from ZIP archives.

### Changed

- Updated the CI, weekly security scan, and release workflows to use GitHub Actions that run on Node.js 24.

## [0.3.7] - 2026-11-25

### Fixed

- Full-text search now reports incomplete results when it reaches a processing limit, including when no matches were found.
- File monitoring now keeps shared documents and ZIP archives watched until the last tab or Explorer releases them, including when an archive is reopened under a different path spelling.

### Changed

- Link inspection skips the folder scan for heading validation when the document only refers to its own headings or images.

## [0.3.6] - 2026-11-25

### Security

- Updated the Rust URL parser to 2.5.9 to fix a stack overflow in URL origin handling (RUSTSEC-2026-0592).
- Updated the Rust cookie dependency to 0.18.3 to address private-cookie nonce reuse after a process fork (RUSTSEC-2026-0594).

## [0.3.5] - 2026-11-20

### Added

- Save and switch between named workspace layouts, restoring open tabs, pane arrangement, zoom, and the visibility of the sidebar and table of contents.
- Compare two revisions of a Markdown document in a local Git repository or compare a revision with the working copy. The rendered view supports synchronized scrolling, highlights inline changes, and displays images from each revision. The side-by-side source diff shows changed Markdown lines.

### Changed

- Reduced repeated work when assigning heading IDs and resolving Wiki links in the preview and document index.

### Security

- Hardened Markdown and Mermaid previews against unsafe content. Document styles stay within the preview, Mermaid respects external-image approval before loading, and the WebView blocks unintended navigation from previews and enlarged diagrams.
- Applied the external-image setting to saved HTML and blocked unapproved image and media loads when the export is opened in a browser.
- Strengthened Windows share approval and saved Explorer root checks. Document and image reads, ignore-rule loading, Wiki indexing, and document listing now apply stricter file and source boundary checks.
- Limited Git history discovery and object reads to the approved scope. Git history loads verified loose and pack objects and disables automatic discovery of external object stores.
- Updated DOMPurify and ZIP handling dependencies and patched the development-only picomatch dependency.

## [0.3.4] - 2026-11-16

### Added

- Added a two-pane split view with independent tabs, scroll positions, view modes, searches, and navigation. Open or move documents to the other pane, resize the split, and restore the layout with the session.
- Expanded YAML frontmatter browsing with selected properties, nested values, configurable display labels, source references, and reverse source lookup. Search properties, tags, folders, and source URLs in native folders and ZIP archives.
- Added expandable update-check error details and a copy button in About, with feedback for copy success and failure.

### Fixed

- Update checks now use the operating system's certificate verification and trust store, allowing trusted enterprise certificate authorities to be recognized. Certificate verification remains enabled.
- Limited update-check waiting to five seconds even when operating-system certificate checks take longer, while preventing duplicate background requests.

### Security

- Updated the indirect webpki-root-certs dependency to 1.0.10 to address a bundled certificate trust advisory.

## [0.3.3] - 2026-11-15

### Fixed

- Restored the saved external-editor executable when loading settings, preventing it from being cleared by a subsequent save after restart. External-editor launches continue to require native authorization.

### Changed

- Updated to markdown-it 15 and deflist 4, using the parser's bundled public types. Preserved automatic links for bare domains and email addresses; Japanese punctuation is now excluded from automatically detected URLs.
- Reduced KaTeX font assets by distributing WOFF2 only while retaining all 20 font faces and the same math-rendering version.
- Updated the test environment to Vitest 5, jsdom 31, and jest-dom 7, with explicit DOM matcher types and Node.js 24.15.0 or newer in the 24.x series.

## [0.3.2] - 2026-11-14

### Security

- Updated Markdown parsing, HTML sanitization, math rendering, ZIP handling, TLS, and certificate-verification dependencies to address security findings.
- Updated frontend build and development tools, including a local deepmerge fix with regression tests for prototype poisoning.

### Changed

- Updated Tauri and selected Rust dependencies to resolve additional safety and maintenance findings.
- Aligned all KaTeX dependencies on the same patched version and added smoke coverage for Markdown and Mermaid math rendering.

## [0.3.1] - 2026-09-25

### Added

- Open a directory's `index.md` from Markdown links, with or without a trailing slash, in local folders and ZIP archives. Heading anchors, previews, backlinks, the link graph, and link validation resolve to the same document. Directories without `index.md` remain missing links; no README fallback is applied.

## [0.3.0] - 2026-09-25

### Changed

- Renamed FeatherMD to Hiranoa, with an open-book application icon and updated distribution names, links, and development tools.
- Changed the application identifier to `com.cocoabreak.hiranoa`. This is a fresh installation: settings, history, tabs, local fonts, and trusted folders are not migrated, and old application data is not automatically deleted.
- Changed the Windows context-menu entry to Hiranoa. Disable the old entry in FeatherMD before uninstalling it, then register the new entry in Hiranoa if desired.
- Moved the repository to `cocoabreak/hiranoa`. Older FeatherMD versions do not follow update-API redirects; download this release manually.

## [0.2.5] - 2026-09-23

### Added

- Added styled GitHub Alerts and Obsidian Callouts with custom titles, folding, nesting, and support for printing and HTML export.
- Added Windows performance report comparisons, process-tree memory measurements, startup phase timings, and frontend size limits in CI.

### Changed

- Updated compatible frontend and Rust dependencies, including Shiki 4.4.3 and its expanded language grammars.
- Removed the obsolete time upper-bound workaround after verifying cookie 0.18.2 with time 0.3.55. The direct base64 dependency remains at 0.22 after compatibility and performance evaluation.

### Fixed

- Fixed weekly security-scan issue notification failures and updated affected dependencies to address security findings.

## [0.2.4] - 2026-08-02

### Added

- Added document and heading reference copying as Wiki links, Markdown links, and Source-relative paths from context menus and the command palette.
- Added missing-image and missing-heading-anchor detection to the link inspector, including bounded validation for native folders and ZIP archives.
- Added user-selected local fonts for Markdown body and code content, with separate slots, safe managed copies, immediate application, restart restoration, and print support.
- Added reproducible Windows release performance tooling for frontend size, startup, rendering, and process-tree memory measurements without adding production runtime hooks.

### Changed

- Expanded shared document-reference and anchor handling across navigation, previews, inspection, NativeSource, and ZipSource.
- Added report-only Windows frontend size metrics to CI and isolated performance release builds from normal application state.
- Updated the affected Rust transitive dependency to remove a reported soundness warning.

### Security

- Kept local-font file selection, validation, storage, and binary loading behind fixed Rust-managed slots and a main-WebView-only Tauri capability.
- Added release CSP support for in-memory local fonts without enabling arbitrary CSS URLs, network fonts, or the asset protocol.
- Hardened document-reference generation and link-problem validation against path escape, syntax injection, oversized inputs, and disclosure of local absolute paths.

## [0.2.3] - 2026-07-27

### Added

- Added a link inspector for the current document, including incoming links, outgoing Markdown and Wiki links, and broken-link status.
- Added a detachable local link graph that visualizes Markdown links, Wiki links, and missing targets.
- Added bounded hover and keyboard-focus previews for resolved local Markdown and Wiki links in both documents and the local link graph.
- Added application screenshots and an animated link-preview demonstration to the English and Japanese READMEs.

### Changed

- Updated npm dependencies to resolve known development-tooling vulnerabilities.
- Added GitHub issue templates and documented the repository's issue workflow.

### Fixed

- Fixed multiline Mermaid node labels so line breaks render correctly without weakening sanitization.
- Aligned document navigation, link inspection, graph traversal, and previews on the shared secure link-resolution contract while excluding absolute paths from passive previews.

## [0.2.2] - 2026-07-20

The first public release of FeatherMD.

### Added

- Read-only viewing for native `.md` and `.markdown` files and for Markdown entries inside ZIP archives.
- Rich Markdown rendering with tables, task lists, footnotes, alerts, emoji, syntax highlighting, KaTeX math, Mermaid diagrams, YAML frontmatter, and trusted local images.
- A folder Explorer, multiple tabs, tab pinning and reordering, closed-tab restoration, file watching, and recent file/folder history.
- Generated outlines, local Markdown links, Wiki links with backlinks, heading anchors, and Back/Forward navigation.
- Rendered/source view switching with independent per-tab scroll positions.
- In-file and directory search, a bounded search-results list, Quick Open, and a searchable command palette.
- Session restoration for tabs, view modes, scroll positions, in-file searches, Explorer expansion, and the last approved Explorer root.
- Large-document safe mode for Markdown files from 5 MiB through 10 MiB, with plain-text viewing and a bounded Rust-generated outline.
- Privacy controls for external HTTPS images: always allow, ask for each document, or block.
- HTML document export, SVG/PNG diagram export, printing/PDF, code copying, reading statistics, and external-editor integration.
- Windows command-line input, single-instance handoff, and optional Explorer context-menu registration for `.md` and `.markdown` files.
- Startup update checks through GitHub Releases, with an option to disable automatic checks in Settings.
- A responsive, accessible interface with English and Japanese localization, native menus, resizable panes, themes, content zoom, and categorized settings.

### Changed

- Improved keyboard and screen-reader support for dialogs, resize handles, search status, drawers, and focus restoration.
- Updated the application identity, metadata, documentation, and icons to the FeatherMD brand and `com.cocoabreak.feathermd` application identifier.
- Hardened trusted-root, path, archive, watcher, export, and session boundaries while keeping filesystem authority in the Rust backend.
- Moved document and diagram exports behind native save dialogs and removed general WebView file-write permission.
- Added watcher and export resource limits and made directory-watch reconciliation atomic.
- Improved reload-time session flushing and restored Explorer and document UI state after an actual WebView reload.
- Removed unused frontend dependencies, corrected runtime/development dependency classification, and updated compatible npm and Cargo dependencies.
- Added Windows WebView2 smoke coverage for core rendering, ZIP, size boundaries, update notification, and session restoration.

### Fixed

- Prevented malformed Mermaid diagrams from leaving temporary error elements outside the document content and disrupting the application layout.
- Preserved successfully rendered Mermaid SVGs while cleaning up Mermaid's temporary rendering elements.
- Preserved stable watcher identities across canonical Windows paths, symlinks, and junctions.
- Prevented export format/extension mismatches and rejected oversized PNG canvas requests before allocation.

### Distribution and security

- Release builds target Windows, Linux, and macOS. Windows releases include MSI and NSIS installers plus a portable ZIP archive and remain the primary supported distribution.
- Release binaries are not code-signed. Windows Defender SmartScreen or macOS Gatekeeper may require explicit user approval; download FeatherMD only from the official GitHub Releases page.
- External images are not loaded silently under the default ask policy, and large documents do not execute rich Markdown rendering in safe mode.
- Startup update checks contact GitHub Releases by default but do not send document contents or local file paths and can be disabled in Settings.

[0.2.4]: https://github.com/cocoabreak/feathermd/releases/tag/v0.2.4
[0.2.3]: https://github.com/cocoabreak/feathermd/releases/tag/v0.2.3
[0.2.2]: https://github.com/cocoabreak/feathermd/releases/tag/v0.2.2
