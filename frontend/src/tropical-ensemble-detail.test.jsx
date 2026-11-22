// S10: Ensemble layers and the cycle selector on the Forecast tab, through the real page
// (design.md 7.4, 7.5, 11h). The map is a stand-in that exposes what it was asked to draw.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import TropicalPage from "./pages/TropicalPage";
import { NOW, makeIndex } from "./tropical/test-fixtures";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";
import { cempakaModels06, cempakaModels12, modelsIndex } from "./tropical/model-test-fixtures";
import { cempakaGefs00, cempakaIfsEns18, ensembleIndex, moveToCycle } from "./tropical/ensemble-test-fixtures";

vi.mock("./pages/tropical/TrackMap", () => ({
  default: ({ items, onSelectNode, onSelectMember }) => (
    <div data-testid="map" data-items={JSON.stringify(items)}>
      {items.filter(item => item.nodeId && item.type !== "circle").map(item => (
        <button key={item.nodeId} type="button" onClick={() => onSelectNode(item.nodeId)}>node {item.nodeId}</button>
      ))}
      {items.filter(item => item.type === "ensembleLine").map(item => (
        <button key={`${item.model}:${item.member}`} type="button" onClick={() => onSelectMember(item.model, item.member)}>
          line {item.model} {item.member}
        </button>
      ))}
    </div>
  ),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = "2026-jma-tc2638";
const MODELS_INDEX_URL = "/data/tropical/models/index.json";
const ENSEMBLE_INDEX_URL = "/data/tropical/ensemble/index.json";
const modelUrl = cycle => `/data/tropical/models/storms/${ID}/${cycle}.json`;
const ensembleUrl = (cycle, model) => `/data/tropical/ensemble/storms/${ID}/${cycle}/${model}.json`;
const BAD_JSON = Symbol("bad json");
const HANG = Symbol("hang");

function serve(routes) {
  const request = vi.fn((url, options = {}) => {
    if (!(url in routes)) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    const route = routes[url];
    if (route instanceof Error) return Promise.reject(route);
    if (route === HANG) {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (route === BAD_JSON) return Promise.resolve({ ok: true, json: async () => { throw new SyntaxError("bad"); } });
    return Promise.resolve({ ok: true, json: async () => route });
  });
  vi.stubGlobal("fetch", request);
  return request;
}

// Two deterministic cycles (06Z GFS/AIGFS, 12Z of the day before IFS/AIFS); the real Ensemble members
// moved to those cycles (synthetic cycle, real tracks) so the same-cycle comparison can be seen.
function routes(edit = {}) {
  return {
    "/data/tropical/official/index.json": makeIndex(),
    [`/data/tropical/official/storms/${ID}/analysis.json`]: cempakaAnalysis(),
    [`/data/tropical/official/storms/${ID}/forecast.json`]: cempakaForecast(),
    [MODELS_INDEX_URL]: modelsIndex({ [ID]: [
      { cycle: "2026111012", models: ["aifs", "ifs"] }, { cycle: "2026111106", models: ["aigfs", "gfs"] }] }),
    [modelUrl("2026111106")]: cempakaModels06(),
    [modelUrl("2026111012")]: cempakaModels12(),
    [ENSEMBLE_INDEX_URL]: ensembleIndex({ [ID]: [
      { cycle: "2026111012", models: { "ifs-ens": { members: 50, members_expected: 51 } } },
      { cycle: "2026111106", models: { gefs: { members: 31, members_expected: 31 } } }] }),
    [ensembleUrl("2026111106", "gefs")]: moveToCycle(cempakaGefs00(), "2026111106"),
    [ensembleUrl("2026111012", "ifs-ens")]: moveToCycle(cempakaIfsEns18(), "2026111012"),
    ...edit,
  };
}

let location = null;
function Probe() {
  location = useLocation();
  return null;
}

async function settle() {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function open(query = "", data = routes()) {
  const request = serve(data);
  render(
    <MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=forecast${query}`]}>
      <TropicalPage getNow={() => NOW} /><Probe />
    </MemoryRouter>,
  );
  await screen.findByTestId("map");
  await settle();
  return request;
}

const requested = request => request.mock.calls.map(([url]) => url);
const ensembleRequests = request => requested(request).filter(url => url.includes("/tropical/ensemble/"));
const modelRequests = request => requested(request).filter(url => url.includes("/tropical/models/"));
const mapItems = () => JSON.parse(screen.getByTestId("map").getAttribute("data-items"));
const section = () => screen.getByRole("group", { name: "Ensemble 成員路徑（原始輸出）" });
const box = name => within(section()).getByRole("checkbox", { name: new RegExp(`^${name}（`) });
const cycleSelect = () => screen.getByRole("combobox", { name: /選擇 cycle/ });
const officialCount = () => mapItems().filter(item => item.agency).length;
const text = () => document.body.textContent;

async function toggle(name) {
  fireEvent.click(box(name));
  await settle();
}

test("Ensemble files are read only when one is switched on, for the cycle shown", async () => {
  const request = await open();
  expect(ensembleRequests(request)).toEqual([]);
  expect(within(section()).getByText(/各成員路徑的分散程度不等於官方機率；外圍範圍不是官方預報範圍。/)).toBeTruthy();
  for (const name of ["GEFS", "AIGEFS", "IFS ENS", "AIFS ENS"]) expect(box(name).checked).toBe(false);
  const official = mapItems();

  await toggle("GEFS");
  expect(ensembleRequests(request)).toEqual([ENSEMBLE_INDEX_URL, ensembleUrl("2026111106", "gefs")]);
  expect(within(section()).getByText("（31 個成員中的 31 個）")).toBeTruthy();
  const items = mapItems();
  expect(items.slice(0, official.length)).toEqual(official);
  const lines = items.filter(item => item.type === "ensembleLine");
  expect(lines.length).toBeGreaterThan(25);
  expect(new Set(lines.map(item => item.model))).toEqual(new Set(["gefs"]));
  expect(items.some(item => item.type === "ensembleNode")).toBe(false); // all members: lines only

  await toggle("IFS ENS"); // the shown cycle (06Z) has no IFS ENS
  expect(within(section()).getByText("（所選的 cycle 沒有此 Ensemble；有此 Ensemble 的 cycle：11-10 12:00 UTC）")).toBeTruthy();
  await toggle("AIFS ENS");
  expect(ensembleRequests(request)).toEqual([ENSEMBLE_INDEX_URL, ensembleUrl("2026111106", "gefs")]);
  expect(text()).not.toMatch(/控制/);
});

test("switching the cycle swaps the deterministic file and every Ensemble switched on; files are read once", async () => {
  const request = await open();
  await toggle("GEFS");
  await toggle("IFS ENS");
  expect(cycleSelect().value).toBe("2026111106");
  expect([...cycleSelect().options].map(option => option.value)).toEqual(["2026111106", "2026111012"]);
  expect(cycleSelect().options[0].textContent).toMatch(/（預設）$/);

  fireEvent.change(cycleSelect(), { target: { value: "2026111012" } });
  await settle();
  expect(location.search).toBe(`?storm=${ID}&tab=forecast&cycle=2026111012`);
  expect(modelRequests(request)).toEqual([MODELS_INDEX_URL, modelUrl("2026111106"), modelUrl("2026111012")]);
  expect(ensembleRequests(request)).toEqual([ENSEMBLE_INDEX_URL, ensembleUrl("2026111106", "gefs"),
    ensembleUrl("2026111012", "ifs-ens")]);
  expect(within(section()).getByText("（51 個成員中的 50 個）")).toBeTruthy();
  expect(within(section()).getByText("（所選的 cycle 沒有此 Ensemble；有此 Ensemble 的 cycle：11-11 06:00 UTC）")).toBeTruthy(); // GEFS now
  expect(new Set(mapItems().filter(item => item.type === "ensembleLine").map(item => item.model))).toEqual(new Set(["ifs-ens"]));
  const models = screen.getByRole("group", { name: "數值模式路徑（原始輸出）" });
  expect(within(models).getByText("模式起報時間（cycle）：", { exact: false }).textContent).toMatch(/2026-11-10 12:00/);
  // Both switches stay on across the change; the deterministic switches too.
  expect(box("GEFS").checked).toBe(true);
  expect(box("IFS ENS").checked).toBe(true);

  fireEvent.change(cycleSelect(), { target: { value: "2026111106" } });
  await settle();
  expect(requested(request).filter(url => url.includes("/tropical/models/") || url.includes("/tropical/ensemble/")))
    .toHaveLength(6); // nothing read twice
});

test("the cycle query parameter: listed, malformed and not listed", async () => {
  let request = await open("&cycle=2026111012");
  expect(cycleSelect().value).toBe("2026111012");
  expect(modelRequests(request)).toEqual([MODELS_INDEX_URL, modelUrl("2026111012")]);
  expect(text()).not.toMatch(/已改為顯示預設的 cycle/);
  cleanup();

  await open("&cycle=2026111103");
  expect(cycleSelect().value).toBe("2026111106");
  expect(screen.getByText("網址中的 cycle 格式不正確，已改為顯示預設的 cycle。")).toBeTruthy();
  cleanup();

  request = await open("&cycle=2026010100");
  expect(cycleSelect().value).toBe("2026111106");
  expect(screen.getByText("網址指定的 cycle 不在目前的資料中，已改為顯示預設的 cycle。")).toBeTruthy();
  expect(modelRequests(request)).toEqual([MODELS_INDEX_URL, modelUrl("2026111106")]);
});

test("one member at a time: from the list or by clicking its line; its nodes join the timeline", async () => {
  await open();
  await toggle("GEFS");
  const ticksBefore = screen.getAllByRole("button", { pressed: false }).length;
  const select = within(section()).getByRole("combobox", { name: "GEFS 顯示的成員" });
  expect(select.value).toBe("");
  expect(select.options[1].textContent).toBe("成員 ac00");
  fireEvent.change(select, { target: { value: "ap05" } });
  await settle();
  let items = mapItems();
  const nodes = items.filter(item => item.type === "ensembleNode");
  expect(nodes.length).toBe(cempakaGefs00().members.find(member => member.m === "ap05").track.length);
  expect(items.filter(item => item.type === "ensembleLine" && item.focused).map(item => item.member)).toEqual(["ap05"]);
  expect(screen.getAllByRole("button", { pressed: false }).length).toBeGreaterThan(ticksBefore);
  expect(within(section()).getByText(/GEFS 成員 ap05：\d+ 個節點/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: `node ${nodes[1].nodeId}` }));
  const detail = screen.getByRole("region", { name: "節點細節" });
  expect(within(detail).getByText("GEFS（NOAA）｜Ensemble 成員 ap05 的節點")).toBeTruthy();
  expect(within(detail).getByText("成員代碼（來源原樣）")).toBeTruthy();
  expect(within(detail).queryByText(/ensembleForecastType/)).toBeNull(); // NOAA has no type
  expect(within(detail).getByText(/各成員路徑的分散程度不等於官方機率/)).toBeTruthy();
  expect(screen.getByRole("button", { pressed: true })).toBeTruthy(); // the timeline moved to it

  // Clicking another line on the map switches the member; the old node is forgotten.
  fireEvent.click(screen.getByRole("button", { name: "line gefs ap10" }));
  await settle();
  items = mapItems();
  expect(items.filter(item => item.type === "ensembleLine" && item.focused).map(item => item.member)).toEqual(["ap10"]);
  expect(screen.queryByRole("region", { name: "節點細節" })).toBeNull();

  // Switching the layer off and on again shows all members.
  await toggle("GEFS");
  expect(mapItems().some(item => item.layer === "ensemble")).toBe(false);
  await toggle("GEFS");
  expect(mapItems().some(item => item.type === "ensembleLine" && item.focused)).toBe(false);
  expect(text()).not.toMatch(/控制/);
});

test("an ECMWF member shows its raw ensembleForecastType, uninterpreted", async () => {
  await open("&cycle=2026111012");
  await toggle("IFS ENS");
  const select = within(section()).getByRole("combobox", { name: "IFS ENS 顯示的成員" });
  expect([...select.options].slice(1, 4).map(option => option.value)).toEqual(["1", "2", "3"]);
  const member = cempakaIfsEns18().members.find(item => item.type === 0) || cempakaIfsEns18().members[0];
  fireEvent.change(select, { target: { value: member.m } });
  await settle();
  const node = mapItems().find(item => item.type === "ensembleNode");
  fireEvent.click(screen.getByRole("button", { name: `node ${node.nodeId}` }));
  const detail = screen.getByRole("region", { name: "節點細節" });
  expect(within(detail).getByText("ensembleForecastType（來源原始代碼，未解讀）")).toBeTruthy();
  expect(within(detail).getByText(String(member.type))).toBeTruthy();
  expect(within(detail).getByText(/m\/s（模式輸出，沒有平均期間）/)).toBeTruthy();
  expect(text()).not.toMatch(/控制|擾動/);
});

const failures = {
  "index 404": { [ENSEMBLE_INDEX_URL]: undefined },
  "index bad JSON": { [ENSEMBLE_INDEX_URL]: BAD_JSON },
  "index schema 2": { [ENSEMBLE_INDEX_URL]: { ...ensembleIndex({}), schema_version: 2 } },
  "index disconnect": { [ENSEMBLE_INDEX_URL]: new TypeError("Failed to fetch") },
  "storm not listed": { [ENSEMBLE_INDEX_URL]: ensembleIndex({}) },
  "listed file 404": { [ensembleUrl("2026111106", "gefs")]: undefined },
  "file bad JSON": { [ensembleUrl("2026111106", "gefs")]: BAD_JSON },
  "file for another storm": { [ensembleUrl("2026111106", "gefs")]: { ...moveToCycle(cempakaGefs00(), "2026111106"), cyclone_id: "2026-jma-tc2639" } },
};

for (const [name, edit] of Object.entries(failures)) {
  test(`Ensemble read failure (${name}) only affects that layer`, async () => {
    const data = routes(edit);
    for (const [url, value] of Object.entries(edit)) if (value === undefined) delete data[url];
    await open("", data);
    const official = officialCount();
    fireEvent.click(screen.getByRole("group", { name: "數值模式路徑（原始輸出）" }).querySelector("input"));
    await toggle("GEFS");
    expect(officialCount()).toBe(official);
    expect(mapItems().some(item => item.type === "modelLine")).toBe(true); // deterministic models unaffected
    expect(mapItems().some(item => item.layer === "ensemble")).toBe(false);
    const message = name.startsWith("index") ? "Ensemble 資料暫時無法取得；官方路徑與確定性模式不受影響。"
      : name === "storm not listed" ? "目前沒有這個系統的 Ensemble 資料。" : "（此資料暫時無法取得）";
    expect(within(section()).getByText(message)).toBeTruthy();
  });
}

test("a request cut off by leaving the tab is not cached and is made again later", async () => {
  const data = routes({ [ensembleUrl("2026111106", "gefs")]: HANG });
  const request = await open("", data);
  await toggle("GEFS");
  expect(within(section()).getByText("（讀取中…）")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "總覽" }));
  await settle();
  fireEvent.click(screen.getByRole("link", { name: "預報路徑" }));
  await screen.findByTestId("map");
  await settle();
  expect(box("GEFS").checked).toBe(false); // switches reset with the tab, like the other layers
  await toggle("GEFS");
  expect(ensembleRequests(request).filter(url => url.endsWith("/gefs.json"))).toHaveLength(2);
  expect(ensembleRequests(request).filter(url => url === ENSEMBLE_INDEX_URL)).toHaveLength(1);
});

test("switching another Ensemble on does not restart a read still in flight", async () => {
  const data = routes({ [ensembleUrl("2026111106", "gefs")]: HANG });
  data[ENSEMBLE_INDEX_URL].storms[ID].cycles[1].models["aigefs"] = { members: 3, members_expected: 31 };
  const request = await open("", data);
  await toggle("GEFS");
  await toggle("AIGEFS");
  expect(ensembleRequests(request).filter(url => url.endsWith("/gefs.json"))).toHaveLength(1);
  const aigefs = ensembleRequests(request).filter(url => url.endsWith("/aigefs.json"));
  expect(aigefs).toEqual([ensembleUrl("2026111106", "aigefs")]);
  expect(within(section()).getByText("（此資料暫時無法取得）")).toBeTruthy(); // AIGEFS 404
});

test("the overview list and other tabs never read Ensemble files", async () => {
  const request = serve(routes());
  render(<MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=overview`]}><TropicalPage getNow={() => NOW} /></MemoryRouter>);
  await screen.findByRole("heading", { name: /資料來源與署名/ });
  await settle();
  expect(ensembleRequests(request)).toEqual([]);
});

test("a cycle in the address that only the Ensemble index lists is used at once, without a jump (review S1)", async () => {
  const data = routes({
    [MODELS_INDEX_URL]: modelsIndex({ [ID]: [{ cycle: "2026111106", models: ["aigfs", "gfs"] }] }),
  });
  const request = await open("&cycle=2026111012", data);
  expect(ensembleRequests(request)).toEqual([ENSEMBLE_INDEX_URL]); // read for the address, no file yet
  expect(modelRequests(request)).toEqual([MODELS_INDEX_URL]); // the 06Z file is never read for nothing
  expect(cycleSelect().value).toBe("2026111012");
  expect(text()).not.toMatch(/已改為顯示預設的 cycle/);
  expect(screen.getByText("所選的 cycle 沒有確定性模式資料。")).toBeTruthy();
  for (const name of ["GEFS", "AIGEFS", "IFS ENS", "AIFS ENS"]) expect(box(name).checked).toBe(false);
  await toggle("IFS ENS");
  expect(cycleSelect().value).toBe("2026111012");
  expect(within(section()).getByText("（51 個成員中的 50 個）")).toBeTruthy();
  await toggle("AIGEFS"); // in no cycle of this storm (review M1)
  expect(within(section()).getByText("（目前沒有這個系統的此 Ensemble 資料）")).toBeTruthy();
});
