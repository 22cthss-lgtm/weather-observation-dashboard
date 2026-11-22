// Real Leaflet (not the stand-in used by tropical-detail.test.jsx) mounted, updated and unmounted in
// jsdom, with and without StrictMode. jsdom has no canvas, so getContext returns a no-op context.
// Guards the teardown: no redraw may run on a destroyed canvas, and only one map stays mounted.
import { StrictMode } from "react";
import { expect, test, vi } from "vitest";
import { act, render } from "@testing-library/react";
import TrackMap from "./pages/tropical/TrackMap";
import { buildTracks, defaultToggles, drawables } from "./tropical/tracks";
import { checkStormFile } from "./tropical/storm-files";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";

const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => ({})), set: (t, k, v) => { t[k] = v; return true; } });
HTMLCanvasElement.prototype.getContext = function () { return ctx; };

test("mount, update, unmount without stray redraw errors", async () => {
  const errors = [];
  const onError = event => { errors.push(String(event.error || event.message)); event.preventDefault(); };
  window.addEventListener("error", onError);
  const spy = vi.spyOn(console, "error").mockImplementation(message => errors.push(String(message)));
  const tracks = buildTracks(checkStormFile(cempakaAnalysis(), "analysis", "2026-jma-tc2638"),
    checkStormFile(cempakaForecast(), "forecast", "2026-jma-tc2638"));
  const items = drawables(tracks, defaultToggles());
  for (const strict of [false, true]) {
    const tree = <TrackMap items={items} colors={{ cwa: "#0f0", jma: "#00f", jtwc: "#f00" }} onSelectNode={() => {}} ready />;
    const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(document.querySelectorAll(".leaflet-container")).toHaveLength(1);
    view.rerender(strict ? <StrictMode>{tree}</StrictMode> : tree);
    view.unmount();
    await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  }
  window.removeEventListener("error", onError);
  spy.mockRestore();
  expect(errors).toEqual([]);
  expect(document.querySelectorAll(".leaflet-container")).toHaveLength(0);
});

test("model layers draw on the real map without errors and stay out of the first fit (11f F6)", async () => {
  const { default: L } = await import("leaflet");
  const { buildModelTracks, checkModelFile, enabledModelTracks } = await import("./tropical/models");
  const { penaModels06 } = await import("./tropical/model-test-fixtures");
  const errors = [];
  const onError = event => { errors.push(String(event.error || event.message)); event.preventDefault(); };
  window.addEventListener("error", onError);
  const spy = vi.spyOn(console, "error").mockImplementation(message => errors.push(String(message)));
  const fit = vi.spyOn(L.Map.prototype, "fitBounds");
  const tracks = buildTracks(checkStormFile(cempakaAnalysis(), "analysis", "2026-jma-tc2638"),
    checkStormFile(cempakaForecast(), "forecast", "2026-jma-tc2638"));
  const file = penaModels06();
  const models = buildModelTracks({ status: "ok", file: checkModelFile(file, "2026-jtwc-04c", file.cycle) });
  const shown = enabledModelTracks(models, { gfs: true, aigfs: true, ifs: false, aifs: false });
  const colors = { cwa: "#0f0", jma: "#00f", jtwc: "#f00", gfs: "#60f", aigfs: "#c06" };
  const officialItems = drawables(tracks, defaultToggles());
  const withModels = drawables(tracks, defaultToggles(), null, null, shown);
  const view = render(<TrackMap items={withModels} colors={colors} onSelectNode={() => {}} ready />);
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  expect(fit).toHaveBeenCalledTimes(1);
  const fitted = fit.mock.calls[0][0];
  const officialPoints = officialItems.flatMap(item => (item.type === "line" ? item.latlngs : item.type === "node" ? [item.latlng] : []));
  const key = points => points.map(point => point.join(",")).sort();
  expect(key(fitted)).toEqual(key(officialPoints)); // the map orders items by type before drawing
  // PENA's model tracks cross 180: plotted longitudes run past 180 instead of wrapping.
  expect(withModels.some(item => item.type === "modelLine" && item.latlngs.some(([, lon]) => lon > 180))).toBe(true);
  view.rerender(<TrackMap items={officialItems} colors={colors} onSelectNode={() => {}} ready />);
  view.rerender(<TrackMap items={withModels} colors={colors} onSelectNode={() => {}} ready />);
  expect(fit).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  fit.mockRestore();
  window.removeEventListener("error", onError);
  spy.mockRestore();
  expect(errors).toEqual([]);
});

test("the largest spaghetti (4 Ensembles, 31-52 members) draws on the real map, stays out of the fit and clicks a member", async () => {
  const { default: L } = await import("leaflet");
  const { buildEnsembleTracks, checkEnsembleFile } = await import("./tropical/ensemble");
  const { cempakaGefs00, cempakaIfsEns18 } = await import("./tropical/ensemble-test-fixtures");
  const errors = [];
  const onError = event => { errors.push(String(event.error || event.message)); event.preventDefault(); };
  window.addEventListener("error", onError);
  const spy = vi.spyOn(console, "error").mockImplementation(message => errors.push(String(message)));
  const fit = vi.spyOn(L.Map.prototype, "fitBounds");
  const added = vi.spyOn(L.Polyline.prototype, "onAdd");
  const ID = "2026-jma-tc2638";
  const tracks = buildTracks(checkStormFile(cempakaAnalysis(), "analysis", ID), checkStormFile(cempakaForecast(), "forecast", ID));
  // Synthetic worst case: the real members copied under the other two Ensembles (AIGEFS 31, AIFS ENS 52).
  const gefs = cempakaGefs00();
  const aigefs = { ...cempakaGefs00(), model: "aigefs", members: gefs.members.map((member, i) => ({ ...member, m: `a0${String(i).padStart(2, "0")}` })) };
  const ifs = cempakaIfsEns18();
  const aifsMembers = [...ifs.members, { ...ifs.members[0], m: "51" }, { ...ifs.members[1], m: "52" }];
  const aifs = { ...cempakaIfsEns18(), model: "aifs-ens", members: aifsMembers.map((member, i) => ({ ...member, m: String(i + 1) })) };
  const files = [checkEnsembleFile(gefs, ID, "2026111100", "gefs"), checkEnsembleFile(aigefs, ID, "2026111100", "aigefs"),
    checkEnsembleFile(ifs, ID, "2026111018", "ifs-ens"), checkEnsembleFile(aifs, ID, "2026111018", "aifs-ens")];
  expect(files.map(file => file.members.length)).toEqual([31, 31, 50, 52]);
  const lines = files.flatMap(buildEnsembleTracks).map(track => ({ ...track, focused: false, dimmed: false }));
  const officialItems = drawables(tracks, defaultToggles());
  const items = drawables(tracks, defaultToggles(), null, null, [], lines);
  const ensembleLines = items.filter(item => item.type === "ensembleLine").length;
  const colors = { cwa: "#0f0", jma: "#00f", jtwc: "#f00", gefs: "#84f", aigefs: "#e48", "ifs-ens": "#1ab", "aifs-ens": "#889" };
  const onSelectMember = vi.fn();
  const view = render(<TrackMap items={items} colors={colors} onSelectNode={() => {}} onSelectMember={onSelectMember} ready />);
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  expect(fit).toHaveBeenCalledTimes(1);
  const officialPoints = officialItems.flatMap(item => (item.type === "line" ? item.latlngs : item.type === "node" ? [item.latlng] : []));
  const key = points => points.map(point => point.join(",")).sort();
  expect(key(fit.mock.calls[0][0])).toEqual(key(officialPoints));
  const officialLines = officialItems.filter(item => item.type === "line").length;
  expect(added.mock.calls.length).toBeGreaterThanOrEqual(ensembleLines + officialLines);
  // A member line fires the member choice (Leaflet's own event path, no real canvas hit test in jsdom).
  const memberLayer = added.mock.contexts.find(layer => layer.listens && layer.listens("click") && layer.options.weight === 1);
  memberLayer.fire("click");
  expect(onSelectMember).toHaveBeenCalledTimes(1);
  expect(onSelectMember.mock.calls[0][0]).toMatch(/^(gefs|aigefs|ifs-ens|aifs-ens)$/);
  view.unmount();
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
  fit.mockRestore();
  added.mockRestore();
  window.removeEventListener("error", onError);
  spy.mockRestore();
  expect(errors).toEqual([]);
});
