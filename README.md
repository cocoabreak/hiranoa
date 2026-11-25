# Hiranoa

<p align="center">
  <img src="docs/images/hiranoa-logo-rounded.svg" alt="Hiranoa logo" width="180">
</p>

[日本語](README.ja.md)

Hiranoa is a fast, read-only viewer for local Markdown files and Markdown documents stored in ZIP archives. It combines a Tauri v2 and Rust backend with a Svelte 5 interface, providing rich rendering without turning the viewer into an editor.

> Hiranoa currently prioritizes Windows. Linux support is a secondary goal, and macOS support is lower priority.

## See it in action

<p align="center">
  <img src="docs/images/hiranoa-link-demo.gif" alt="Hiranoa previews a linked document, shows the local link graph, and opens a document by clicking a graph node" width="1000">
</p>

<p align="center"><em>Preview linked documents, explore the local link graph, and click a node to jump to its document.</em></p>

## Highlights

- **Rich Markdown rendering** — CommonMark-style Markdown, GitHub-style tables and task lists, GitHub Alerts, Obsidian Callouts, syntax highlighting with Shiki, KaTeX math, Mermaid diagrams, emoji, and YAML frontmatter.
- **Native files and ZIP archives** — Open `.md` and `.markdown` files directly, or browse Markdown entries in a ZIP without extracting it. For documents from 5 MiB through 10 MiB, safe mode lets you read the source as plain text and jump between headings using the outline.
- **Highlights and reading notes** — Select a passage to highlight it in one of three colors or add a note on the spot. Use **Annotations** in the right panel to jump back to a passage. If a revision leaves its location unclear, the original quote and note stay in the list. You can select a new passage to reattach them.
- **Explorer and tabs** — Open a folder as the Explorer root, lazily browse Markdown files, open and reorder multiple tabs, pin tabs, reopen a closed tab, and track file changes automatically.
- **Navigation and link inspection** — Navigate with the outline, heading anchors, local links, Wiki links (`[[Page]]`), and Back/Forward history. Preview a link target or explore the link graph in its own window. The link inspector shows incoming and outgoing links, missing images, and missing heading targets. Copy a reference to a document or heading as a Wiki link or Markdown link.
- **Search and quick access** — Search within the current page, or find documents in an open folder or ZIP by text, frontmatter properties, tags, or source URL. Look up which documents cite a particular source. Full-text search labels results as incomplete when it reaches a processing limit. Quick Open finds files by name, and the command palette finds actions.
- **Images and diagrams** — Resolve trusted local images safely and inspect images or Mermaid diagrams in a zoomable, pannable lightbox.
- **Desktop workflows** — Open files or folders from native dialogs, drag and drop, recent history, keyboard shortcuts, the command line, or the optional Windows Explorer context menu.
- **Split view and workspaces** — Read two documents side by side, each with its own tabs, reading position, and in-page search. Restore pinned tabs, the active tab, view modes, and the Explorer state and root on restart. Save tabs, pane arrangements, and zoom levels as named layouts to switch between tasks.
- **Git history and diffs** — Compare two revisions of a Markdown document in a local Git repository, or compare a revision with the working copy. Use synchronized scrolling to compare the rendered versions, or switch to a line-by-line source diff to inspect changes in Markdown syntax.
- **Customization** — Light, dark, and system themes, content zoom, resizable panels, separate local fonts for body text and code, renderer toggles, code themes, optional line numbers, and scoped custom CSS.
- **Utilities** — Rendered/source view switching, code-copy buttons, reading statistics, external-editor integration, printing/PDF, HTML export, and SVG/PNG export for diagrams.
- **Localized UI** — Japanese and English UI, including the native application menu.

## Security model

Hiranoa treats Markdown as potentially untrusted input. The guarantees below describe release builds.

- When reading documents or local images and scanning directories, the Rust backend checks the resolved target against the scope approved for that operation. Relative document links and local image references inside a ZIP resolve within that archive.
- Drive roots, Windows system directories, and the user-profile root cannot be trusted as broad Explorer roots.
- The WebView cannot silently add trusted folders. New folders require an OS-originated action or a native confirmation dialog.
- On restart, Hiranoa restores trust only for the last explicitly approved Explorer root. It verifies that this is the same directory that was approved. Replacing the directory at the same path requires fresh approval.
- Git history comparison is read-only and stays within the approved document and local repository scope. It uses no remote connections, Git hooks, or external diff tools. Approving history access does not grant broader file access.
- Rendered HTML is sanitized, Mermaid uses strict security settings, and the app runs with a restrictive Content Security Policy.
- Local Markdown, images, custom CSS, searches, and directory traversal have type, size, or entry-count limits where applicable.
- At startup, Hiranoa checks GitHub Releases for a newer version by default. This can be disabled in Settings. The update request does not include document contents or local file paths.
- By default, external HTTPS images load only after you approve them for the current document. This policy also covers images in Mermaid diagrams. Exported HTML reflects the image permissions in effect at export time. Links in enlarged Mermaid diagrams are disabled.
- Hiranoa stores annotations locally in its own storage and leaves the original Markdown or ZIP untouched. If you open identical content at another path, you choose whether to move or copy its annotations. You can export and import annotations per document as JSON. A shared export includes the notes, quoted passages, short excerpts before and after each quote, and the headings used to locate them.

This model limits what a malicious document can access, but it does not make an untrusted file inherently safe. Review unexpected confirmation prompts before approving them.

> Development builds expose a debug-only authorization hook for CDP-based UI testing. Do not use `npm run tauri dev` to inspect untrusted documents; use a release build for that purpose.

## Common shortcuts

| Action                    | Shortcut                      |
| ------------------------- | ----------------------------- |
| Open file / folder        | `Ctrl+O` / `Ctrl+Shift+O`     |
| Find in page / directory  | `Ctrl+F` / `Ctrl+Shift+F`     |
| Back / Forward            | `Alt+Left` / `Alt+Right`      |
| Next / previous tab       | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Close active tab          | `Ctrl+W`                      |
| Toggle Explorer / outline | `Ctrl+B` / `Ctrl+J`           |
| Open settings             | `Ctrl+,`                      |
| Content zoom              | `Ctrl++`, `Ctrl+-`, `Ctrl+0`  |

The title-bar menu shows the native application menu and its available commands.

## Installation

### Moving from FeatherMD

Hiranoa 0.3.0 is the renamed successor to FeatherMD and installs as a separate application. Settings, history, tabs, local fonts, and trusted folders are not imported. Existing FeatherMD data is not automatically deleted.

Before uninstalling FeatherMD, turn off its Windows context-menu option in Settings. Then install Hiranoa, select your folders again, and enable its context-menu option if needed. Reassign any file associations or shortcuts that still point to FeatherMD. Older FeatherMD versions may stop checking for updates after the repository rename; download Hiranoa manually from the Releases link below.

Release packages are published on [GitHub Releases](https://github.com/cocoabreak/hiranoa/releases).

Release binaries are not code-signed. Windows Defender SmartScreen may therefore show an "unrecognized app" warning, and macOS may block an unnotarized application until the user explicitly approves it. Download Hiranoa only from the official Releases page above and confirm that you trust the source before bypassing an operating-system warning.

| Platform                    | Support level | Distribution notes                                                                                                       |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Windows x64                 | Primary       | MSI and NSIS (`.exe`) installers plus `Hiranoa_<version>_x64-portable.zip`. Microsoft Edge WebView2 Runtime is required. |
| Linux x64                   | Best effort   | CI-built packages are published with the release; desktop integration may vary by distribution.                          |
| macOS (Apple Silicon/Intel) | Experimental  | A universal CI build is published, but macOS has the lowest support priority and the application is not notarized.       |

### Build prerequisites

These are required only when building Hiranoa from source:

- Node.js 24 LTS
- Rust and Cargo
- Platform prerequisites required by Tauri v2
- Windows: Microsoft Edge WebView2 Runtime (included with current Windows 11 installations)

### Build and run from source

```bash
git clone https://github.com/cocoabreak/hiranoa.git
cd hiranoa/app
npm ci
npm run tauri dev
```

Create a release build with:

```bash
npm run tauri build
```

### Quality checks

Run frontend checks from `app/`:

```bash
npm run format
npm run lint
npm run check
npm test
```

Run Rust checks from `app/src-tauri/`:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. The feature specifications and architectural decisions are maintained under [`.kiro/specs`](.kiro/specs) and [`docs/decisions`](docs/decisions).

Release history is available in the [changelog](CHANGELOG.md).

## License

Hiranoa is licensed under the [MIT License](LICENSE).
