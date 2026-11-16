import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "$lib/i18n/index.svelte";
import UpdateCheckError from "./UpdateCheckError.svelte";

const details = 'TLS error: UnknownIssuer\n<img src=x onerror="alert(1)">';
const writeText = vi.fn();

describe("UpdateCheckError", () => {
  beforeEach(() => {
    i18n.setLocale("ja");
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("詳細をHTMLとして解釈せず表示し、同じ全文をコピーする", async () => {
    writeText.mockResolvedValue(undefined);
    const { container } = render(UpdateCheckError, { details });
    await fireEvent.click(screen.getByText("エラー詳細"));

    expect(container.querySelector("pre")?.textContent).toBe(details);
    expect(container.querySelector("img")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "エラー詳細をコピー" }));

    expect(writeText).toHaveBeenCalledWith(details);
    expect(screen.getByRole("status")).toHaveTextContent("コピーしました");
  });

  it("コピー失敗を表示して詳細を残し、再度コピーできる", async () => {
    writeText.mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
    const { container } = render(UpdateCheckError, { details });
    await fireEvent.click(screen.getByText("エラー詳細"));
    const button = screen.getByRole("button", { name: "エラー詳細をコピー" });

    await fireEvent.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("コピーできませんでした");
    expect(container.querySelector("pre")?.textContent).toBe(details);

    await fireEvent.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("コピーしました");
  });
});
