import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import MetadataSummary from "./MetadataSummary.svelte";
import MetadataTree from "./MetadataTree.svelte";
import MetadataSettings from "./MetadataSettings.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { i18n } from "$lib/i18n/index.svelte";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const original = JSON.parse(JSON.stringify(settingsStore.settings.metadataDisplayFields));
afterEach(() => {
  settingsStore.setMetadataDisplayFields(original);
  vi.clearAllMocks();
});

describe("metadata reading UI", () => {
  it("shows selected properties in configured order without promoting document status", () => {
    settingsStore.setMetadataDisplayFields([
      { key: "review_status", label: "確認", values: { unverified: "未確認" } },
      { key: "recorded_on", label: "記録日", values: {} },
    ]);
    render(MetadataSummary, {
      raw: "---\nreview_status: unverified\nrecorded_on: 2026-11-13\nprivate: hidden\n---\n# Gold",
    });
    expect(screen.getByText("未確認")).toBeInTheDocument();
    expect(screen.getByText("2026-11-13")).toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("human-reviewed")).not.toBeInTheDocument();
  });
  it("reports invalid metadata and leaves plain Markdown without a metadata header", () => {
    const view = render(MetadataSummary, { raw: "# Plain" });
    expect(view.container.querySelector("dl")).toBeNull();
    view.unmount();
    render(MetadataSummary, { raw: "---\nx: [\n---\n# Body" });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
  it("renders nested registration context as expandable text without interpreting HTML", async () => {
    render(MetadataTree, {
      value: { registration_context: { purpose: "<img src=x onerror=alert(1)>" } },
    });
    const summary = screen.getByText("registration_context");
    await fireEvent.click(summary);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
  it("saves labels and ordered properties through the existing app settings store", async () => {
    render(MetadataSettings);
    await fireEvent.click(screen.getByText(i18n.m.metadata.fields));
    await fireEvent.input(screen.getAllByLabelText(i18n.m.metadata.label)[0], {
      target: { value: "確認状態" },
    });
    await fireEvent.click(screen.getByRole("button", { name: i18n.m.metadata.save }));
    expect(settingsStore.settings.metadataDisplayFields[0].label).toBe("確認状態");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_app_state",
        expect.objectContaining({
          kind: "settings",
          value: expect.objectContaining({
            settings: expect.objectContaining({ metadataDisplayFields: expect.any(Array) }),
          }),
        })
      )
    );
  });
});
