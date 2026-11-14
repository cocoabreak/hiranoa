import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { loadSettings, saveSettings } from "$lib/settings-store";
import { settingsStore } from "$lib/stores/settings.svelte";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
  settingsStore.setExternalEditorCommand("");
});

describe("external editor settings persistence", () => {
  it("保存済みパスを復元し、他の設定を保存しても消さない", async () => {
    const editor = "C:/Program Files/日本語 Editor/editor.exe";
    invokeMock.mockResolvedValueOnce({ settings: { externalEditorCommand: editor } });
    await loadSettings();
    expect(settingsStore.settings.externalEditorCommand).toBe(editor);
    expect(invokeMock).toHaveBeenCalledTimes(1);

    invokeMock.mockResolvedValueOnce(undefined);
    settingsStore.toggleHiddenFiles();
    await saveSettings();
    expect(invokeMock).toHaveBeenLastCalledWith("save_app_state", {
      kind: "settings",
      value: { settings: expect.objectContaining({ externalEditorCommand: editor }) },
    });
  });

  it("空欄の保存値も復元する", async () => {
    settingsStore.setExternalEditorCommand("C:/old-editor.exe");
    invokeMock.mockResolvedValueOnce({ settings: { externalEditorCommand: "" } });
    await loadSettings();
    expect(settingsStore.settings.externalEditorCommand).toBe("");
  });

  it("文字列以外の保存値を無視する", async () => {
    invokeMock.mockResolvedValueOnce({ settings: { externalEditorCommand: ["editor.exe"] } });
    await loadSettings();
    expect(settingsStore.settings.externalEditorCommand).toBe("");
  });
});
