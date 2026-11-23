import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TropicalPage from "./pages/TropicalPage";
import { Attribution, modelProductNames } from "./pages/tropical/common";
import { JTWC_GRAPHIC_PATTERN, OFFICIAL_PAGES, jtwcGraphic } from "./tropical/imagery";
import { NOW, cempaka, makeIndex } from "./tropical/test-fixtures";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";

// Imagery tab, site links and the final attribution (design.md 7.6, 11i).
vi.mock("./pages/tropical/TrackMap", () => ({
  default: ({ items }) => <div data-testid="map" data-items={JSON.stringify(items)} />,
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ID = "2026-jma-tc2638";
const GIF = "https://www.metoc.navy.mil/jtwc/products/wp3126.gif";
const INDEX_URL = "/data/tropical/official/index.json";
const fileUrl = kind => `/data/tropical/official/storms/${ID}/${kind}.json`;

function serve({ index = makeIndex(), analysis = cempakaAnalysis(), forecast = cempakaForecast() } = {}) {
  const routes = { [INDEX_URL]: index, [fileUrl("forecast")]: forecast };
  if (analysis !== null) routes[fileUrl("analysis")] = analysis;
  const request = vi.fn(async url => (url in routes
    ? { ok: true, json: async () => routes[url] }
    : { ok: false, status: 404, json: async () => ({}) }));
  vi.stubGlobal("fetch", request);
  return request;
}

async function openImagery(options) {
  const request = serve(options);
  render(<MemoryRouter initialEntries={[`/tropical?storm=${ID}&tab=imagery`]}><TropicalPage getNow={() => NOW} /></MemoryRouter>);
  await screen.findByRole("heading", { name: /資料來源與署名/ });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return request;
}

const jtwcCard = () => screen.getByRole("region", { name: "JTWC 聯合颱風警報中心 警報圖" });

function withJtwc(change) {
  const analysis = cempakaAnalysis();
  change(analysis.agencies.jtwc, analysis);
  return analysis;
}

test("the JTWC warning graphic is linked from JTWC with source, image time and fetch time apart", async () => {
  const request = await openImagery();
  const card = jtwcCard();
  const image = within(card).getByRole("img");
  expect(image.getAttribute("src")).toBe(GIF);
  expect(image.getAttribute("alt")).toBe("JTWC 熱帶氣旋警報圖（第 021 報）");
  expect(within(card).getByText(/JTWC 熱帶氣旋警報圖（TC Warning Graphic），第 021 報/)).toBeTruthy();
  const times = [...card.querySelectorAll("dt")].map(dt => [dt.textContent, dt.nextElementSibling.textContent]);
  expect(times).toEqual([
    ["來源", "JTWC 熱帶氣旋警報圖（TC Warning Graphic），第 021 報"],
    ["警報發布時間", "2026-11-11 09:00 UTC臺灣 2026-11-11 17:00"],
    ["圖像對應的分析時間", "2026-11-11 06:00 UTC臺灣 2026-11-11 14:00"],
    ["本站抓取時間（詳細資料產生時間）", "2026-11-11 10:30 UTC臺灣 2026-11-11 18:30"],
  ]);
  expect(within(card).getByText(/可能比上列報次新/)).toBeTruthy();
  expect(within(card).getByRole("link", { name: "在 JTWC 網站開啟原圖" }).getAttribute("href")).toBe(GIF);
  expect(card.textContent).not.toMatch(/最終報|已結束/);
  // The image is loaded by the browser, never fetched by the page (design.md 7.4).
  expect(request.mock.calls.map(([url]) => url)).toEqual([INDEX_URL, fileUrl("analysis"), fileUrl("forecast")]);
});

test("a broken official image shows the SourceImage-style notice and an official link", async () => {
  await openImagery();
  fireEvent.error(within(jtwcCard()).getByRole("img"));
  const card = jtwcCard();
  expect(within(card).queryByRole("img")).toBeNull();
  expect(within(card).getByRole("status").textContent).toMatch(/此官方圖片目前無法取得/);
  expect(within(within(card).getByRole("status")).getByRole("link", { name: "JTWC 網站" }).getAttribute("href"))
    .toBe(OFFICIAL_PAGES.jtwc.href);
  // Times stay, so the reader still knows which warning the page had.
  expect(within(card).getByText("圖像對應的分析時間")).toBeTruthy();
});

test.each([
  ["no graphic", null],
  ["another host", "https://evil.example/jtwc/products/wp3126.gif"],
  ["plain http", "http://www.metoc.navy.mil/jtwc/products/wp3126.gif"],
  ["not a gif", "https://www.metoc.navy.mil/jtwc/products/31W_110600sair.jpg"],
  ["a path escape", "https://www.metoc.navy.mil/jtwc/products/../x.gif"],
  ["a query", "https://www.metoc.navy.mil/jtwc/products/wp3126.gif?x=1"],
  // Review S2: the rule must be anchored at the start, not just match somewhere inside.
  ["a valid address after a prefix", "https://evil.example/r?u=https://www.metoc.navy.mil/jtwc/products/wp3126.gif"],
  ["a valid address after whitespace", " https://www.metoc.navy.mil/jtwc/products/wp3126.gif"],
  ["not a string", 42],
])("%s: no <img> is drawn and JTWC's site is linked instead", async (_, url) => {
  await openImagery({ analysis: withJtwc(block => { block.graphic_url = url; }) });
  const card = jtwcCard();
  expect(within(card).queryByRole("img")).toBeNull();
  expect(within(card).getByText(/這一報的資料沒有 JTWC 警報圖的連結/)).toBeTruthy();
  expect(document.body.innerHTML).not.toContain("evil.example");
});

test("no JTWC block, a bad JTWC block and an unreadable analysis.json each say so", async () => {
  await openImagery({ analysis: withJtwc((_, analysis) => { analysis.agencies.jtwc = null; }) });
  expect(within(jtwcCard()).getByText("JTWC 目前沒有這個系統的資料，因此沒有警報圖。")).toBeTruthy();
  cleanup();
  await openImagery({ analysis: withJtwc(block => { block.fix = null; }) });
  expect(within(jtwcCard()).getByText("JTWC 的資料暫時無法取得，無法顯示警報圖。")).toBeTruthy();
  cleanup();
  await openImagery({ analysis: null });
  expect(within(jtwcCard()).getByText("JTWC 的資料暫時無法取得，無法顯示警報圖。")).toBeTruthy();
  // The other agencies' links and the site links do not depend on analysis.json.
  expect(screen.getByRole("link", { name: OFFICIAL_PAGES.jma.label })).toBeTruthy();
  expect(screen.getByRole("region", { name: "相關環境圖資（本站既有頁面）" })).toBeTruthy();
});

test("an ended storm's final warning is flagged and warns the image may be gone", async () => {
  const ended = cempaka({ status: "ended", ended_at: "2026-11-11T10:00:00Z" });
  for (const summary of Object.values(ended.summary)) summary.active = false;
  await openImagery({
    index: makeIndex({ status: "OK_NO_STORMS", storms: [ended] }),
    analysis: withJtwc(block => { block.final = true; }),
  });
  const card = jtwcCard();
  expect(within(card).getByText("最終報")).toBeTruthy();
  expect(within(card).getByText(/^JTWC 熱帶氣旋警報圖/).textContent).toBe("JTWC 熱帶氣旋警報圖（TC Warning Graphic），第 021 報，最終報");
  expect(within(card).getByText(/此系統已結束，官方圖片可能已被移除/)).toBeTruthy();
});

test("JMA and CWA link their official pages; the site's image pages and the attribution are linked", async () => {
  await openImagery();
  const jma = screen.getByRole("region", { name: "JMA 日本氣象廳" });
  expect(within(jma).getByRole("link").getAttribute("href")).toBe("https://www.jma.go.jp/bosai/map.html#contents=typhoon");
  expect(within(jma).queryByRole("img")).toBeNull();
  const cwa = screen.getByRole("region", { name: "CWA 中央氣象署" });
  expect(within(cwa).getByRole("link").getAttribute("href")).toBe("https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html");
  expect(within(cwa).queryByRole("img")).toBeNull();
  for (const link of [...jma.querySelectorAll("a"), ...cwa.querySelectorAll("a")]) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  }
  const links = screen.getByRole("region", { name: "相關環境圖資（本站既有頁面）" });
  expect(within(links).getAllByRole("link").map(link => link.getAttribute("href"))).toEqual([
    "/images/satellite", "/images/cimss_wind_analysis", "/images/cimss_steering_flow", "/images/tchp", "/images/sst",
  ]);
  const toFooter = screen.getByRole("link", { name: "資料來源與署名" });
  expect(document.getElementById(toFooter.getAttribute("href").slice(1)).textContent).toBe("資料來源與署名");
});

test("the graphic rule matches the backend validator's examples", () => {
  expect(JTWC_GRAPHIC_PATTERN.test(GIF)).toBe(true);
  expect(JTWC_GRAPHIC_PATTERN.test("https://www.metoc.navy.mil/jtwc/products/sh0427.gif")).toBe(true);
  expect(jtwcGraphic({ graphic_url: GIF })).toBe(GIF);
  expect(jtwcGraphic({ graphic_url: `https://www.metoc.navy.mil/jtwc/products/${"a".repeat(81)}.gif` })).toBeNull();
  expect(jtwcGraphic(null)).toBeNull();
  expect(jtwcGraphic({})).toBeNull();
});

test.each([
  [true, true, "數值模式 GFS、AIGFS 與 Ensemble GEFS、AIGEFS", "數值模式 IFS、AIFS 與 Ensemble IFS ENS、AIFS ENS"],
  [true, false, "數值模式 GFS、AIGFS", "數值模式 IFS、AIFS"],
  [false, true, "Ensemble GEFS、AIGEFS", "Ensemble IFS ENS、AIFS ENS"],
])("models %s, ensemble %s: each line names only the switched-on products (H17 (1))", (models, ensemble, noaa, ecmwf) => {
  expect(modelProductNames(models, ensemble)).toEqual({ noaa, ecmwf });
  render(<Attribution models={models} ensemble={ensemble} />);
  const footer = screen.getByRole("contentinfo");
  expect(within(footer).getByText(`NOAA／NWS（${noaa}）：`)).toBeTruthy();
  expect(within(footer).getByText(`ECMWF（${ecmwf}）：`)).toBeTruthy();
  expect(footer.textContent).toMatch(/非官方預報，亦非本站預報/);
});

test("with both switches off there is no NOAA, ECMWF or model line", () => {
  render(<Attribution models={false} ensemble={false} />);
  const footer = screen.getByRole("contentinfo");
  expect(footer.textContent).not.toMatch(/NOAA|ECMWF|數值模式|Ensemble/);
  expect(footer.textContent).toMatch(/JTWC/);
});

test("the ECMWF line carries the terms' service wording verbatim, with licence and disclaimer", () => {
  render(<Attribution models ensemble />);
  const text = screen.getByRole("contentinfo").textContent.replace(/\s+/g, " ");
  for (const sentence of [
    'Copyright statement: Copyright "This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)".',
    "Source www.ecmwf.int Licence Statement:",
    "Licence Statement: This ECMWF data is published under a Creative Commons Attribution 4.0 International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/",
    "Disclaimer: ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.",
    "提供機關／交通部中央氣象署 颱風消息與警報-熱帶氣旋路徑（W-C0034-005）。",
    "此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。",
    "出典：気象庁ホームページ（https://xml.kishou.go.jp/xmlpull.html）。",
    "気象庁「気象庁防災情報XMLフォーマット形式電文の公開（PULL型）」（https://xml.kishou.go.jp/xmlpull.html）を加工して作成",
  ]) expect(text).toContain(sentence);
  expect(text).toMatch(/修改說明：本站已修改原始資料/);
  const hrefs = [...screen.getByRole("contentinfo").querySelectorAll("a")].map(a => a.getAttribute("href"));
  expect(hrefs).toEqual(expect.arrayContaining([
    "https://xml.kishou.go.jp/xmlpull.html", "https://data.gov.tw/license", "https://www.ecmwf.int/",
    "https://creativecommons.org/licenses/by/4.0/",
  ]));
});

test.each([
  [true, true, "數值模式與 Ensemble 成員路徑是模式的原始輸出", true],
  [true, false, "數值模式路徑是模式的原始輸出", false],
  [false, true, "Ensemble 成員路徑是模式的原始輸出", true],
])("models %s, ensemble %s: the model note and ECMWF change note follow the switches (review L3)", (models, ensemble, note, members) => {
  render(<Attribution models={models} ensemble={ensemble} />);
  const text = screen.getByRole("contentinfo").textContent;
  expect(text).toContain(note);
  expect(text.includes("Ensemble 成員編號與原始類型代碼")).toBe(members);
});

test("no stray half-width space between Chinese sentences in the attribution and imagery text (review L2)", async () => {
  render(<Attribution models ensemble />);
  expect(screen.getByRole("contentinfo").textContent).not.toMatch(/[；：。，」）] [\u4e00-\u9fff（「]/);
  cleanup();
  await openImagery();
  expect(document.querySelector(".tc-section").textContent).not.toMatch(/[；：。，」）] [\u4e00-\u9fff（「]|頁尾 「/);
});