import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TropicalPage from "./pages/TropicalPage";
import { NOW, makeIndex } from "./tropical/test-fixtures";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";
import { cempakaGefs00, ensembleIndex } from "./tropical/ensemble-test-fixtures";

// VITE_TROPICAL_MODEL_LAYERS=off with the Ensemble layers on (design.md 11h H3/H7): the cycles come
// from the Ensemble index alone, read only once an Ensemble is switched on.
vi.mock("./tropical/features", () => ({ MODEL_LAYERS_ENABLED: false, ENSEMBLE_LAYERS_ENABLED: true }));
vi.mock("./pages/tropical/TrackMap", () => ({
  default: ({ items }) => <div data-testid="map" data-items={JSON.stringify(items)} />,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = "2026-jma-tc2638";

test("without the deterministic layers the Ensemble layers still work on their own cycles", async () => {
  const routes = {
    "/data/tropical/official/index.json": makeIndex(),
    [`/data/tropical/official/storms/${ID}/analysis.json`]: cempakaAnalysis(),
    [`/data/tropical/official/storms/${ID}/forecast.json`]: cempakaForecast(),
    "/data/tropical/ensemble/index.json": ensembleIndex({ [ID]: [
      { cycle: "2026111100", models: { gefs: { members: 31, members_expected: 31 } } }] }),
    [`/data/tropical/ensemble/storms/${ID}/2026111100/gefs.json`]: cempakaGefs00(),
  };
  const request = vi.fn(async url => (url in routes
    ? { ok: true, json: async () => routes[url] }
    : { ok: false, status: 404, json: async () => ({}) }));
  vi.stubGlobal("fetch", request);
  render(<MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=forecast`]}><TropicalPage getNow={() => NOW} /></MemoryRouter>);
  await screen.findByTestId("map");
  const settle = async () => {
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  };
  await settle();
  const urls = () => request.mock.calls.map(([url]) => url).filter(url => url.includes("/models/") || url.includes("/ensemble/"));
  expect(urls()).toEqual([]);
  expect(screen.queryByRole("group", { name: "數值模式路徑（原始輸出）" })).toBeNull();
  const section = screen.getByRole("group", { name: "Ensemble 成員路徑（原始輸出）" });
  fireEvent.click(within(section).getByRole("checkbox", { name: /^GEFS（/ }));
  await settle();
  expect(urls()).toEqual(["/data/tropical/ensemble/index.json", `/data/tropical/ensemble/storms/${ID}/2026111100/gefs.json`]);
  expect(within(section).getByText("（31 個成員中的 31 個）")).toBeTruthy();
  const cycles = screen.getByRole("group", { name: "數值模式與 Ensemble 的起報時間（cycle）" });
  expect(within(cycles).getByText(/目前只有一個 cycle：2026-11-11 00:00/)).toBeTruthy();
  expect(within(screen.getByRole("contentinfo")).getByText(/ECMWF（數值模式/)).toBeTruthy();
  expect(screen.getByText(/已開啟的 Ensemble 起報時間（cycle）：/)).toBeTruthy(); // review M3
  expect(screen.getByText(/已開啟的 Ensemble 起報時間（cycle）與官方起報時間不同/)).toBeTruthy(); // recheck N1
  expect(document.body.textContent).not.toMatch(/已開啟的數值模式起報時間/);
});

test("no cycle at all: an address cycle does not claim a default was shown (review M2)", async () => {
  const routes = {
    "/data/tropical/official/index.json": makeIndex(),
    [`/data/tropical/official/storms/${ID}/analysis.json`]: cempakaAnalysis(),
    [`/data/tropical/official/storms/${ID}/forecast.json`]: cempakaForecast(),
  };
  vi.stubGlobal("fetch", vi.fn(async url => (url in routes
    ? { ok: true, json: async () => routes[url] }
    : { ok: false, status: 404, json: async () => ({}) })));
  render(<MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=forecast&cycle=2026010100`]}><TropicalPage getNow={() => NOW} /></MemoryRouter>);
  await screen.findByTestId("map");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const cycles = screen.getByRole("group", { name: "數值模式與 Ensemble 的起報時間（cycle）" });
  expect(within(cycles).getByText("目前沒有可選的 cycle。")).toBeTruthy();
  expect(cycles.textContent).not.toMatch(/已改為顯示預設的 cycle/);
});
