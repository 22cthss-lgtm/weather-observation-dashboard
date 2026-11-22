// S10: Ensemble reading checks, member tracks, cycle choice and the spaghetti drawables (design.md 1.8,
// 1.9, 7.4, 7.5, 11h). Pure functions only; no clock, no network.
import { expect, test } from "vitest";
import {
  ENSEMBLES, ENSEMBLE_NOTE, buildEnsembleTracks, checkEnsembleFile, checkEnsembleIndex, compareMembers,
  ensembleCycles, ensembleFileKey, fetchTropicalEnsembleFile, findEnsembleNode, formatMemberCount,
} from "./tropical/ensemble";
import { modelCycles, parseCycleQuery } from "./tropical/models";
import { chooseCycle } from "./pages/tropical/useForecastFiles";
import { buildTimeline, buildTracks, defaultToggles, drawables } from "./tropical/tracks";
import { checkStormFile } from "./tropical/storm-files";
import { cempakaAnalysis, cempakaForecast } from "./tropical/storm-test-fixtures";
import { cempakaGefs00, cempakaIfsEns18, ensembleIndex, penaGefs00 } from "./tropical/ensemble-test-fixtures";

const ID = "2026-jma-tc2638";
const PENA = "2026-jtwc-04c";

test("the real GEFS and IFS ENS samples pass the frontend checks unchanged", () => {
  const gefs = checkEnsembleFile(cempakaGefs00(), ID, "2026111100", "gefs");
  expect(gefs.members).toHaveLength(31);
  expect(gefs.membersExpected).toBe(31);
  expect(gefs.dropped).toBe(0);
  expect(gefs.members.map(member => member.m).slice(0, 3)).toEqual(["ac00", "ap01", "ap02"]);
  expect(gefs.members.every(member => member.type === null)).toBe(true);
  const ifs = checkEnsembleFile(cempakaIfsEns18(), ID, "2026111018", "ifs-ens");
  expect(ifs.members).toHaveLength(50);
  expect(ifs.membersExpected).toBe(51);
  expect(new Set(ifs.members.map(member => member.type))).toEqual(new Set([0, 4]));
  expect(formatMemberCount(ifs.members.length, ifs.membersExpected)).toBe("51 個成員中的 50 個");
});

test("file-level mismatches are read failures", () => {
  const good = cempakaGefs00();
  expect(checkEnsembleFile(good, ID, "2026111100", "aigefs")).toBeNull(); // model differs
  expect(checkEnsembleFile(good, "2026-jma-tc2639", "2026111100", "gefs")).toBeNull();
  expect(checkEnsembleFile(good, ID, "2026111106", "gefs")).toBeNull();
  expect(checkEnsembleFile(good, ID, "2026111100", "nope")).toBeNull();
  const edits = [
    file => { file.schema_version = 2; },
    file => { file.init_time = "2026-11-11T06:00:00Z"; },
    file => { file.provider = "ECMWF"; },
    file => { file.wind_unit = "m/s"; },
    file => { file.members_expected = 0; },
    file => { file.members_expected = "31"; },
    file => { file.members = {}; },
    file => { file.members = Array.from({ length: 61 }, () => file.members[0]); },
  ];
  for (const edit of edits) {
    const file = cempakaGefs00();
    edit(file);
    expect(checkEnsembleFile(file, ID, "2026111100", "gefs")).toBeNull();
  }
  for (const bad of [null, [], "x", 1]) expect(checkEnsembleFile(bad, ID, "2026111100", "gefs")).toBeNull();
});

test("a bad member is left out and counted; the rest of the file is kept", () => {
  const file = cempakaGefs00();
  file.members[1].m = "ap31"; // not a GEFS member id
  file.members[2].track[1][0] = 7; // not a multiple of 6
  file.members[3].type = 4; // NOAA has no type, but the frontend only checks the raw range
  file.members[4].type = 256;
  file.members[5] = { ...file.members[0] }; // repeated ac00
  file.members[6].track = [];
  const checked = checkEnsembleFile(file, ID, "2026111100", "gefs");
  expect(checked.dropped).toBe(5);
  expect(checked.members).toHaveLength(26);
  expect(checked.members.filter(member => member.m === "ac00")).toHaveLength(1);
  const empty = cempakaGefs00();
  empty.members = [];
  expect(checkEnsembleFile(empty, ID, "2026111100", "gefs").members).toEqual([]);
});

test("ECMWF members sort by number, NOAA codes by text, whatever order the file has", () => {
  const file = cempakaIfsEns18();
  const ordered = file.members.map(member => member.m);
  expect(ordered.slice(0, 3)).toEqual(["1", "2", "3"]);
  expect(ordered.map(Number)).toEqual([...ordered.map(Number)].sort((a, b) => a - b));
  file.members.reverse();
  expect(checkEnsembleFile(file, ID, "2026111018", "ifs-ens").members.map(member => member.m)).toEqual(ordered);
  expect(["10", "2", "1"].sort(compareMembers)).toEqual(["1", "2", "10"]);
  expect(["ap02", "ac00", "ap10", "ap01"].sort(compareMembers)).toEqual(["ac00", "ap01", "ap02", "ap10"]);
});

test("member ids follow each ensemble's own range", () => {
  const ifs = cempakaIfsEns18();
  ifs.members[0].m = "52"; // only AIFS ENS has 52 members
  expect(checkEnsembleFile(ifs, ID, "2026111018", "ifs-ens").dropped).toBe(1);
  const aifs = { ...cempakaIfsEns18(), model: "aifs-ens" };
  aifs.members[0].m = "52";
  expect(checkEnsembleFile(aifs, ID, "2026111018", "aifs-ens").dropped).toBe(0);
  for (const bad of ["0", "01", " 1", "1.0", "ac00"]) {
    const file = cempakaIfsEns18();
    file.members[0].m = bad;
    expect(checkEnsembleFile(file, ID, "2026111018", "ifs-ens").dropped).toBe(1);
  }
});

test("member tracks: valid time = init + tau, ids carry the member, no interpolation", () => {
  const file = checkEnsembleFile(cempakaGefs00(), ID, "2026111100", "gefs");
  const tracks = buildEnsembleTracks(file);
  expect(tracks).toHaveLength(31);
  const first = tracks[0];
  expect(first.member).toBe("ac00");
  expect(first.points).toHaveLength(file.members[0].track.length);
  expect(first.points[0]).toMatchObject({ id: "ens:gefs:ac00:0", kind: "ensemble", time: "2026-11-11T00:00:00Z", tauH: 0 });
  const last = file.members[0].track.at(-1);
  expect(first.points.at(-1).time).toBe(new Date(Date.parse("2026-11-11T00:00:00Z") + last[0] * 3600000).toISOString().slice(0, 19) + "Z");
  expect(findEnsembleNode(tracks, "ens:gefs:ap05:1").member).toBe("ap05");
  expect(findEnsembleNode(tracks, "model:gfs:1")).toBeNull();
  expect(buildEnsembleTracks(null)).toEqual([]);
});

test("PENA members crossing 180 stay continuous on the 0-360 map", () => {
  const tracks = buildEnsembleTracks(checkEnsembleFile(penaGefs00(), PENA, "2026111100", "gefs"));
  for (const track of tracks) {
    for (let i = 1; i < track.points.length; i += 1) {
      expect(Math.abs(track.points[i].plotLon - track.points[i - 1].plotLon)).toBeLessThan(20);
    }
  }
  expect(tracks.some(track => track.points.some(point => point.lon < 0))).toBe(true);
});

test("index: storm entries, counts and malformed entries", () => {
  expect(checkEnsembleIndex({ schema_version: 2, storms: {} })).toBeNull();
  expect(checkEnsembleIndex({ schema_version: 1, storms: [] })).toBeNull();
  const index = ensembleIndex({ [ID]: [
    { cycle: "2026111018", models: { "ifs-ens": { members: 50, members_expected: 51 } } },
    { cycle: "2026111100", models: { gefs: { members: 28, members_expected: 31 }, other: {} } },
  ] });
  const entry = ensembleCycles(checkEnsembleIndex(index), ID);
  expect(entry.status).toBe("ok");
  expect(entry.cycles.map(item => item.cycle)).toEqual(["2026111018", "2026111100"]);
  expect(entry.cycles[1].models).toEqual({ gefs: { members: 28, membersExpected: 31 } });
  expect(ensembleCycles(index, "2026-jma-tc2639")).toEqual({ status: "none" });
  expect(ensembleCycles(index, "__proto__")).toEqual({ status: "none" });
  expect(ensembleCycles(ensembleIndex({ [ID]: [] }), ID)).toEqual({ status: "none" });
  for (const cycles of [[{ cycle: "2026111103", models: {} }], [{ cycle: "2026111100", models: [] }],
    [{ cycle: "2026111100", models: {} }, { cycle: "2026111018", models: {} }], "x"]) {
    expect(ensembleCycles(ensembleIndex({ [ID]: cycles }), ID)).toEqual({ status: "unavailable" });
  }
});

test("file requests are built only from checked values", async () => {
  expect(ensembleFileKey(ID, "2026111100", "gefs")).toBe(`ensemble/${ID}/2026111100/gefs`);
  for (const [id, cycle, model] of [["../x", "2026111100", "gefs"], [ID, "2026111103", "gefs"], [ID, "2026111100", "../gefs"],
    [ID, "2026023100", "gefs"]]) {
    await expect(fetchTropicalEnsembleFile(id, cycle, model)).rejects.toThrow();
  }
});

test("cycle query parameter and cycle choice", () => {
  const parse = text => parseCycleQuery(new URLSearchParams(text));
  expect(parse("")).toEqual({ cycle: null, invalid: false });
  expect(parse("cycle=2026111100")).toEqual({ cycle: "2026111100", invalid: false });
  for (const bad of ["2026111103", "2026023100", "20261111", "x", "2026111100%0A"]) {
    expect(parse(`cycle=${bad}`)).toEqual({ cycle: null, invalid: true });
  }
  // The newest deterministic cycle is the default even when the Ensemble index lists a newer one.
  expect(chooseCycle(["2026111018", "2026111100"], ["2026111106"], null))
    .toEqual({ options: ["2026111018", "2026111100", "2026111106"], selected: "2026111100", latest: "2026111100", requestedMissing: false });
  expect(chooseCycle([], ["2026111018", "2026111100"], null).selected).toBe("2026111100");
  expect(chooseCycle(["2026111100"], [], "2026111018")).toMatchObject({ selected: "2026111100", requestedMissing: true });
  expect(chooseCycle(["2026111018", "2026111100"], [], "2026111018")).toMatchObject({ selected: "2026111018", requestedMissing: false });
  expect(chooseCycle([], [], null)).toEqual({ options: [], selected: null, latest: null, requestedMissing: false });
});

test("modelCycles lists every cycle in order and rejects a broken list", () => {
  const index = { storms: { [ID]: { cycles: [{ cycle: "2026111012", models: ["ifs", "x"] }, { cycle: "2026111106", models: ["gfs"] }] } } };
  expect(modelCycles(index, ID)).toEqual({ status: "ok", cycles: [
    { cycle: "2026111012", models: ["ifs"] }, { cycle: "2026111106", models: ["gfs"] }] });
  expect(modelCycles({ storms: { [ID]: { cycles: [] } } }, ID)).toEqual({ status: "none" });
  expect(modelCycles({ storms: {} }, ID)).toEqual({ status: "none" });
  expect(modelCycles({ storms: { [ID]: { cycles: [{ cycle: "2026111106" }, { cycle: "2026111012" }] } } }, ID))
    .toEqual({ status: "unavailable" });
});

function lines(file, focus = null) {
  return buildEnsembleTracks(file).map(track => ({
    ...track, focused: track.member === focus, dimmed: focus !== null && track.member !== focus,
  }));
}

test("spaghetti: one thin line per member, nodes and ticks only for the member looked at alone", () => {
  const tracks = buildTracks(checkStormFile(cempakaAnalysis(), "analysis", ID), checkStormFile(cempakaForecast(), "forecast", ID));
  const official = drawables(tracks, defaultToggles());
  const file = checkEnsembleFile(cempakaGefs00(), ID, "2026111100", "gefs");
  const all = drawables(tracks, defaultToggles(), null, null, [], lines(file));
  expect(all.slice(0, official.length)).toEqual(official);
  const added = all.slice(official.length);
  expect(added.every(item => item.type === "ensembleLine")).toBe(true);
  expect(added).toHaveLength(file.members.filter(member => member.track.length > 1).length);
  expect(added.some(item => item.focused || item.dimmed)).toBe(false);
  expect(buildTimeline(tracks, [], []).ticks).toEqual(buildTimeline(tracks).ticks);

  const focused = drawables(tracks, defaultToggles(), null, "ens:gefs:ap05:2", [], lines(file, "ap05"));
  const nodes = focused.filter(item => item.type === "ensembleNode");
  expect(nodes).toHaveLength(file.members.find(member => member.m === "ap05").track.length);
  expect(nodes.every(item => item.member === "ap05")).toBe(true);
  expect(nodes.filter(item => item.selected).map(item => item.nodeId)).toEqual(["ens:gefs:ap05:2"]);
  const ensembleLines = focused.filter(item => item.type === "ensembleLine");
  expect(ensembleLines.filter(item => item.focused).map(item => item.member)).toEqual(["ap05"]);
  expect(ensembleLines.filter(item => item.dimmed)).toHaveLength(ensembleLines.length - 1);
  // Nothing that combines members: no area, no mean line.
  expect(focused.some(item => item.layer === "ensemble" && !["ensembleLine", "ensembleNode", "ensembleDot"].includes(item.type))).toBe(false);

  const member = lines(file, "ap05").filter(line => line.focused);
  const timeline = buildTimeline(tracks, [], member);
  const memberEntries = timeline.ticks.flatMap(tick => tick.entries).filter(entry => entry.ensemble);
  expect(memberEntries).toHaveLength(nodes.length);
  expect(memberEntries[0]).toMatchObject({ ensemble: "gefs", member: "ap05", agency: null, model: null });
  expect(timeline.analysis).toEqual(buildTimeline(tracks).analysis); // "latest analysis" stays official only
});

test("the fixed wording says what the spread is not", () => {
  expect(ENSEMBLE_NOTE).toBe("各成員路徑的分散程度不等於官方機率；外圍範圍不是官方預報範圍。");
  expect(ENSEMBLES).toEqual(["gefs", "aigefs", "ifs-ens", "aifs-ens"]);
});

test("a member with a single point is a small dot that selects it, a node once chosen (review S2)", () => {
  const tracks = buildTracks(checkStormFile(cempakaAnalysis(), "analysis", ID), checkStormFile(cempakaForecast(), "forecast", ID));
  const raw = cempakaGefs00();
  raw.members[1].track = raw.members[1].track.slice(0, 1);
  const file = checkEnsembleFile(raw, ID, "2026111100", "gefs");
  const member = file.members[1].m;
  const all = drawables(tracks, defaultToggles(), null, null, [], lines(file));
  expect(all.filter(item => item.type === "ensembleDot").map(item => item.member)).toEqual([member]);
  expect(all.filter(item => item.type === "ensembleLine")).toHaveLength(file.members.length - 1);
  const focused = drawables(tracks, defaultToggles(), null, null, [], lines(file, member));
  expect(focused.some(item => item.type === "ensembleDot")).toBe(false);
  expect(focused.filter(item => item.type === "ensembleNode").map(item => item.member)).toEqual([member]);
});
