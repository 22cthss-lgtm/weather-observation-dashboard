import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TropicalPage from "./pages/TropicalPage";
import { NOW, makeIndex } from "./tropical/test-fixtures";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";
import { cempakaModels06, modelsIndex } from "./tropical/model-test-fixtures";

// VITE_TROPICAL_ENSEMBLE_LAYERS=off with the deterministic layers on (design.md 11h H7).
vi.mock("./tropical/features", () => ({ MODEL_LAYERS_ENABLED: true, ENSEMBLE_LAYERS_ENABLED: false }));
vi.mock("./pages/tropical/TrackMap", () => ({
  default: ({ items }) => <div data-testid="map" data-items={JSON.stringify(items)} />,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = "2026-jma-tc2638";

test("with only the Ensemble switch off there is no Ensemble section or request; models stay", async () => {
  const routes = {
    "/data/tropical/official/index.json": makeIndex(),
    [`/data/tropical/official/storms/${ID}/analysis.json`]: cempakaAnalysis(),
    [`/data/tropical/official/storms/${ID}/forecast.json`]: cempakaForecast(),
    "/data/tropical/models/index.json": modelsIndex({ [ID]: [{ cycle: "2026111106", models: ["aigfs", "gfs"] }] }),
    [`/data/tropical/models/storms/${ID}/2026111106.json`]: cempakaModels06(),
  };
  const request = vi.fn(async url => (url in routes
    ? { ok: true, json: async () => routes[url] }
    : { ok: false, status: 404, json: async () => ({}) }));
  vi.stubGlobal("fetch", request);
  render(<MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=forecast`]}><TropicalPage getNow={() => NOW} /></MemoryRouter>);
  await screen.findByTestId("map");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(request.mock.calls.map(([url]) => url).filter(url => url.includes("/ensemble/"))).toEqual([]);
  expect(screen.queryByRole("group", { name: "Ensemble 成員路徑（原始輸出）" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/Ensemble 各成員|各成員路徑的分散程度/);
  expect(screen.getByRole("group", { name: "數值模式路徑（原始輸出）" })).toBeTruthy();
  const cycles = screen.getByRole("group", { name: "數值模式與 Ensemble 的起報時間（cycle）" });
  expect(within(cycles).getByText(/目前只有一個 cycle：2026-11-11 06:00/)).toBeTruthy();
  const footer = screen.getByRole("contentinfo");
  expect(within(footer).getByText(/NOAA／NWS（數值模式 GFS、AIGFS）：/)).toBeTruthy();
  expect(within(footer).getByText(/ECMWF（數值模式 IFS、AIFS）：/)).toBeTruthy();
  expect(footer.textContent).not.toMatch(/GEFS|AIGEFS|IFS ENS|AIFS ENS/);
});
