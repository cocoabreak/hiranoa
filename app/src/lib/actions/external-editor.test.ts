import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { openExternalEditor } from "$lib/actions/file-actions";
import { settingsStore } from "$lib/stores/settings.svelte";

const invokeMock = vi.mocked(invoke);
const editor = "C:/Program Files/日本語 Editor/editor.exe";
const document = "C:/notes/日本語 note.md";

beforeEach(() => {
  vi.clearAllMocks();
  invokeMock.mockReset();
  settingsStore.setExternalEditorCommand(editor);
});

describe("external editor authorization", () => {
  it("保存済みパスをRustで認可してから文書を開く", async () => {
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
    await openExternalEditor(document);
    expect(invokeMock.mock.calls).toEqual([
      ["authorize_external_editor", { path: editor }],
      ["open_in_editor", { path: document }],
    ]);
  });

  it("ネイティブ確認を拒否した場合は起動しない", async () => {
    invokeMock.mockResolvedValueOnce(false);
    await openExternalEditor(document);
    expect(invokeMock.mock.calls).toEqual([["authorize_external_editor", { path: editor }]]);
  });

  it("起動エラーを表示し、保存済みエディターは消さない", async () => {
    const error = new Error("editor unavailable");
    invokeMock.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await openExternalEditor(document);
      expect(message).toHaveBeenCalledWith(expect.stringContaining(error.message), {
        title: expect.any(String),
        kind: "error",
      });
      expect(settingsStore.settings.externalEditorCommand).toBe(editor);
      expect(invokeMock).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
