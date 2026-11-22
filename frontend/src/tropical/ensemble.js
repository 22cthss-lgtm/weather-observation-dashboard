// Ensemble (spaghetti) tracks for the Forecast tab (design.md 1.8, 1.9, 7.4, 7.5, 11g, 11h).
// Reading, the minimum shape checks the page relies on and the member track model.
// The backend validator (fetchers/src/tropical_contract.py validate_ensemble_index /
// validate_ensemble_file) is stricter. Nothing here reads the clock, and nothing here
// combines members: no envelope, no probability, no mean (design.md 7.5).
import { readStatic } from "../api";
import { CYCLONE_ID_PATTERN } from "./status";
import { cycleTime, stampOf, validTrack } from "./models";
import { unwrapLon } from "./tracks";

const HOUR_MS = 3600 * 1000;

/** Display order; the data lists ensembles alphabetically. */
export const ENSEMBLES = ["gefs", "aigefs", "ifs-ens", "aifs-ens"];

// Member ids each ensemble may have (design.md 1.9, 11g G9); `expected` is members_expected.
export const ENSEMBLE_INFO = {
  gefs: {
    short: "GEFS", label: "GEFS（NOAA）", provider: "NOAA", windUnit: "kt", color: "#845ef7", expected: 31,
    member: /^(?:ac00|ap(?:0[1-9]|[12][0-9]|30))$/,
  },
  aigefs: {
    short: "AIGEFS", label: "AIGEFS（NOAA，AI 模式）", provider: "NOAA", windUnit: "kt", color: "#e64980", expected: 31,
    member: /^a0(?:[0-2][0-9]|30)$/,
  },
  "ifs-ens": {
    short: "IFS ENS", label: "IFS ENS（ECMWF）", provider: "ECMWF", windUnit: "m/s", color: "#15aabf", expected: 51,
    member: /^(?:[1-9]|[1-4][0-9]|5[01])$/,
  },
  "aifs-ens": {
    short: "AIFS ENS", label: "AIFS ENS（ECMWF，AI 模式）", provider: "ECMWF", windUnit: "m/s", color: "#868e96", expected: 52,
    member: /^(?:[1-9]|[1-4][0-9]|5[0-2])$/,
  },
};

export const ENSEMBLE_COLORS = Object.fromEntries(ENSEMBLES.map(model => [model, ENSEMBLE_INFO[model].color]));

// Fixed wording (design.md 1.9, 7.5): shown with the layer switches, the legend and member details.
export const ENSEMBLE_NOTE = "各成員路徑的分散程度不等於官方機率；外圍範圍不是官方預報範圍。";

export const ENSEMBLE_INDEX_PATH = "data/tropical/ensemble/index.json";
export const ENSEMBLE_INDEX_KEY = "ensemble/index";
const MAX_MEMBERS = 60;

export function ensembleFileKey(cycloneId, cycle, model) {
  return `ensemble/${cycloneId}/${cycle}/${model}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function fetchTropicalEnsembleIndex({ signal } = {}) {
  return readStatic(ENSEMBLE_INDEX_PATH, { signal });
}

// The id, cycle and model are checked again here so a path can never be built from an unchecked value.
export function fetchTropicalEnsembleFile(cycloneId, cycle, model, { signal } = {}) {
  if (typeof cycloneId !== "string" || !CYCLONE_ID_PATTERN.test(cycloneId) || cycleTime(cycle) === null
    || !ENSEMBLES.includes(model)) {
    return Promise.reject(new Error("Invalid tropical ensemble file request"));
  }
  return readStatic(`data/tropical/ensemble/storms/${cycloneId}/${cycle}/${model}.json`, { signal });
}

/** File-level check of tropical/ensemble/index.json; null means "could not read". */
export function checkEnsembleIndex(data) {
  if (!isPlainObject(data) || data.schema_version !== 1 || !isPlainObject(data.storms)) return null;
  return data;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * This storm's cycles in a checked Ensemble index (design.md 1.8), oldest first.
 * @returns {status: "none"} | {status: "unavailable"} |
 *   {status: "ok", cycles: [{cycle, models: {gefs: {members, membersExpected}, ...}}]}
 *   Only the four known ensembles are kept; the counts are null when they are not usable numbers.
 */
export function ensembleCycles(index, cycloneId) {
  if (!own(index.storms, cycloneId)) return { status: "none" };
  const entry = index.storms[cycloneId];
  if (!isPlainObject(entry) || !Array.isArray(entry.cycles)) return { status: "unavailable" };
  if (!entry.cycles.length) return { status: "none" };
  const cycles = [];
  for (const item of entry.cycles) {
    if (!isPlainObject(item) || cycleTime(item.cycle) === null || !isPlainObject(item.models)) {
      return { status: "unavailable" };
    }
    if (cycles.some(known => known.cycle >= item.cycle)) return { status: "unavailable" };
    const models = {};
    for (const model of ENSEMBLES) {
      if (!own(item.models, model)) continue;
      const value = isPlainObject(item.models[model]) ? item.models[model] : {};
      models[model] = { members: count(value.members), membersExpected: count(value.members_expected) };
    }
    cycles.push({ cycle: item.cycle, models });
  }
  return { status: "ok", cycles };
}

/** Sort key of design.md 1.9 / 11g G9: ECMWF member numbers as numbers, NOAA codes as text. */
export function compareMembers(left, right) {
  const a = /^[0-9]+$/.test(left);
  const b = /^[0-9]+$/.test(right);
  if (a && b) return Number(left) - Number(right);
  if (a !== b) return a ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validMember(model, member) {
  if (!isPlainObject(member) || typeof member.m !== "string" || !ENSEMBLE_INFO[model].member.test(member.m)) return false;
  // `type` is the raw ECMWF ensembleForecastType, kept as is and never read as "control" (1.9).
  if (member.type !== null && !(Number.isInteger(member.type) && member.type >= 0 && member.type <= 255)) return false;
  return validTrack(member.track);
}

/**
 * Check of tropical/ensemble/storms/{id}/{cycle}/{model}.json.
 * @returns null when the file cannot be used at all (a read failure), otherwise
 *   { cycle, model, initTime, membersExpected, members: [{m, type, track}], dropped }
 *   A member that fails its own check is left out and counted in `dropped`; so is a repeated id.
 */
export function checkEnsembleFile(data, cycloneId, cycle, model) {
  const info = ENSEMBLE_INFO[model];
  if (!info || !isPlainObject(data) || data.schema_version !== 1 || data.cyclone_id !== cycloneId
    || data.cycle !== cycle || data.model !== model) {
    return null;
  }
  const init = cycleTime(cycle);
  if (init === null || data.init_time !== stampOf(init)) return null;
  if (data.provider !== info.provider || data.wind_unit !== info.windUnit) return null;
  if (!Number.isInteger(data.members_expected) || data.members_expected < 1) return null;
  if (!Array.isArray(data.members) || data.members.length > MAX_MEMBERS) return null;
  const seen = new Set();
  const members = [];
  let dropped = 0;
  for (const member of data.members) {
    if (!validMember(model, member) || seen.has(member.m)) {
      dropped += 1;
      continue;
    }
    seen.add(member.m);
    members.push({ m: member.m, type: member.type, track: member.track });
  }
  members.sort((left, right) => compareMembers(left.m, right.m));
  return { cycle, model, initTime: data.init_time, membersExpected: data.members_expected, members, dropped };
}

/** "31 個成員中的 28 個" (design.md 1.8). */
export function formatMemberCount(members, expected) {
  return `${expected} 個成員中的 ${members} 個`;
}

/**
 * One track per member of a checked file. Valid time = init_time + tau_h; no interpolation.
 * Node ids carry the ensemble and the member, never a "control" label.
 */
export function buildEnsembleTracks(file) {
  if (!file) return [];
  const init = Date.parse(file.initTime);
  const info = ENSEMBLE_INFO[file.model];
  return file.members.map(member => ({
    model: file.model,
    member: member.m,
    type: member.type,
    initTime: file.initTime,
    points: member.track.map(([tau, lat, lon, pressure, wind], index) => ({
      id: `ens:${file.model}:${member.m}:${index}`,
      model: file.model, member: member.m, memberType: member.type, kind: "ensemble",
      time: stampOf(init + tau * HOUR_MS),
      tauH: tau,
      lat, lon, plotLon: unwrapLon(lon),
      pressure, wind,
      windUnit: info.windUnit,
      provider: info.provider,
      initTime: file.initTime,
    })),
  }));
}

export function defaultEnsembleToggles() {
  // Every Ensemble layer starts off and shows all members once switched on.
  return Object.fromEntries(ENSEMBLES.map(model => [model, false]));
}

export function defaultEnsembleFocus() {
  return Object.fromEntries(ENSEMBLES.map(model => [model, null]));
}

export function findEnsembleNode(ensembleTracks, nodeId) {
  if (typeof nodeId !== "string" || !nodeId.startsWith("ens:")) return null;
  for (const track of ensembleTracks) {
    for (const point of track.points) if (point.id === nodeId) return point;
  }
  return null;
}
