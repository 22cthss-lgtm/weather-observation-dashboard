import { afterEach, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import SourceImage from "./SourceImage";

afterEach(() => { cleanup(); });

const image = (time, url = `https://example.com/radar/${time}.png`) =>
  ({ title: `Radar ${time}`, image_url: url, source_url: "https://www.cwa.gov.tw/" });
const notice = () => screen.queryByText(/此時次的官方圖片目前無法取得/);

test("a failed image is replaced by the notice and an official link", () => {
  render(<SourceImage image={image("00:00")} />);
  fireEvent.error(screen.getByAltText("Radar 00:00"));
  expect(notice()).toBeTruthy();
  expect(screen.getByRole("link", { name: "查看官方來源" }).getAttribute("href")).toBe("https://www.cwa.gov.tw/");
  expect(screen.queryByAltText("Radar 00:00")).toBeNull();
});

test("another URL is tried again, and so is a failed one shown again later", () => {
  const { rerender } = render(<SourceImage image={image("00:00")} />);
  fireEvent.error(screen.getByAltText("Radar 00:00"));
  expect(notice()).toBeTruthy();
  rerender(<SourceImage image={image("00:10")} />);
  expect(notice()).toBeNull();
  expect(screen.getByAltText("Radar 00:10").getAttribute("src")).toBe("https://example.com/radar/00:10.png");
  rerender(<SourceImage image={image("00:00")} />);
  expect(notice()).toBeNull();
  expect(screen.getByAltText("Radar 00:00")).toBeTruthy();
});

test("a new object with the same URL keeps the failure", () => {
  const { rerender } = render(<SourceImage image={image("00:00")} />);
  fireEvent.error(screen.getByAltText("Radar 00:00"));
  rerender(<SourceImage image={{ ...image("00:00") }} />);
  expect(notice()).toBeTruthy();
});

test("an error that arrives before React has run the mount's effects still shows the notice", async () => {
  // The publishing tests saw this order under React 19: the image error came while the mount's
  // passive effects were still pending. Render outside act so those effects are not flushed, then
  // fire the error as soon as the image is in the document (the old component failed here).
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    root.render(<SourceImage image={image("00:00")} />);
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  let img = null;
  for (let tries = 0; !img && tries < 50; tries += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    img = container.querySelector("img");
  }
  try {
    expect(img).toBeTruthy();
    act(() => { fireEvent.error(img); });
    expect(container.textContent).toContain("此時次的官方圖片目前無法取得");
  } finally {
    act(() => { root.unmount(); });
    container.remove();
  }
});
