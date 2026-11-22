// Model and Ensemble reads for the Forecast tab (design.md 7.4, 11f F2, 11h H2/H3).
// Mounted only with the Forecast tab, so nothing here is requested on the other tabs.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MODELS_INDEX_KEY, checkModelFile, checkModelsIndex, fetchTropicalModelsFile, fetchTropicalModelsIndex,
  modelCycles, modelFileKey,
} from "../../tropical/models";
import {
  ENSEMBLES, ENSEMBLE_INDEX_KEY, checkEnsembleFile, checkEnsembleIndex, ensembleCycles, ensembleFileKey,
  fetchTropicalEnsembleFile, fetchTropicalEnsembleIndex,
} from "../../tropical/ensemble";

export const REQUEST_TIMEOUT_MS = 15000;

/**
 * Reads every `{key, request, check}` not yet in the page-lifetime `cache`. Results, failures and
 * timeouts included, are cached, so each file is read at most once. A request that is no longer
 * wanted (another cycle chosen, a layer switched off, the tab closed) is aborted and not cached,
 * so it is made again when it is wanted again. Requests still wanted are never restarted.
 */
function useCachedFiles(cache, requests) {
  const [, setVersion] = useState(0);
  const pending = useRef(new Map());
  const latest = useRef(requests);
  latest.current = requests;
  const keys = requests.map(item => item.key).join("|");

  useEffect(() => {
    const wanted = new Set();
    for (const { key, request, check } of latest.current) {
      wanted.add(key);
      if (cache.has(key) || pending.current.has(key)) continue;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const entry = { controller, timer };
      pending.current.set(key, entry);
      request({ signal: controller.signal })
        .then(check)
        .catch(() => null)
        .then(result => {
          if (pending.current.get(key) !== entry) return; // dropped while in flight: not cached
          pending.current.delete(key);
          cache.set(key, result);
          setVersion(current => current + 1);
        })
        .finally(() => clearTimeout(timer));
    }
    for (const [key, entry] of pending.current) {
      if (wanted.has(key)) continue;
      pending.current.delete(key);
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
  }, [keys, cache]);

  useEffect(() => {
    const inFlight = pending.current;
    return () => {
      for (const entry of inFlight.values()) {
        clearTimeout(entry.timer);
        entry.controller.abort();
      }
      inFlight.clear();
    };
  }, []);
}

function settled(cache, key) {
  return cache.has(key) ? { done: true, value: cache.get(key) } : { done: false, value: undefined };
}

/**
 * Which cycle the tab shows (design.md 11h H3). Options are the cycles listed for this storm in
 * the models index and, once it has been read, the Ensemble index. The default is the newest
 * deterministic cycle (the newest Ensemble cycle when there is none), so reading the Ensemble
 * index never moves the default. A requested cycle that is not listed falls back to the default.
 */
export function chooseCycle(modelList, ensembleList, requested) {
  const options = [...new Set([...modelList, ...ensembleList])].sort();
  const fallback = modelList.length ? modelList[modelList.length - 1] : options[options.length - 1] ?? null;
  const listed = requested !== null && options.includes(requested);
  return { options, selected: listed ? requested : fallback, latest: fallback, requestedMissing: requested !== null && !listed };
}

/**
 * @param ensembleOn the Ensembles switched on; the Ensemble index is read the first time one is
 * @returns {
 *   cycles: {options, selected, latest, requestedMissing, settled},
 *   models: null (switch off) | {status: "loading"|"unavailable"|"none"|"nocycle"} | {status: "ok", cycle, file},
 *   ensemble: null (switch off) | {index: "idle"|"loading"|"unavailable"|"none"|"ok",
 *     models: {gefs: {status: "off"|"loading"|"unavailable"|"none"|"nocycle"} | {status: "ok", file}, ...}},
 * }
 */
export function useForecastFiles({ cycloneId, cache, modelsEnabled, ensembleEnabled, requestedCycle, ensembleOn }) {
  const requests = [];
  if (modelsEnabled) requests.push({ key: MODELS_INDEX_KEY, request: fetchTropicalModelsIndex, check: checkModelsIndex });

  const modelsIndex = settled(cache, MODELS_INDEX_KEY);
  const modelInfo = !modelsEnabled || !modelsIndex.done ? null
    : modelsIndex.value === null ? { status: "unavailable" } : modelCycles(modelsIndex.value, cycloneId);
  const modelList = modelInfo && modelInfo.status === "ok" ? modelInfo.cycles.map(item => item.cycle) : [];
  // A `cycle` in the address that the deterministic list does not have may be an Ensemble-only
  // cycle (11h H16): the Ensemble index is read at once, so the page decides one time and does
  // not jump to that cycle later when an Ensemble is switched on.
  const urlNeedsEnsembleIndex = ensembleEnabled && requestedCycle !== null && (!modelsEnabled || modelsIndex.done)
    && !modelList.includes(requestedCycle);
  const wantEnsembleIndex = ensembleEnabled && (ensembleOn.length > 0 || urlNeedsEnsembleIndex);
  if (wantEnsembleIndex) {
    requests.push({ key: ENSEMBLE_INDEX_KEY, request: fetchTropicalEnsembleIndex, check: checkEnsembleIndex });
  }
  const ensembleIndex = settled(cache, ENSEMBLE_INDEX_KEY);
  const ensembleInfo = !ensembleEnabled || !ensembleIndex.done ? null
    : ensembleIndex.value === null ? { status: "unavailable" } : ensembleCycles(ensembleIndex.value, cycloneId);

  const ensembleList = ensembleInfo && ensembleInfo.status === "ok" ? ensembleInfo.cycles.map(item => item.cycle) : [];
  const choice = chooseCycle(modelList, ensembleList, requestedCycle);
  const selected = choice.selected;
  // The fallback hint waits for the indexes that can list cycles, so it does not flash while loading.
  const cyclesSettled = (!modelsEnabled || modelsIndex.done) && (!wantEnsembleIndex || ensembleIndex.done);
  // While that index is on its way, no cycle file is read (it would be the wrong cycle).
  const resolving = urlNeedsEnsembleIndex && !ensembleIndex.done;

  let modelKey = null;
  if (!resolving && modelInfo && modelInfo.status === "ok" && modelList.includes(selected)) {
    modelKey = modelFileKey(cycloneId, selected);
    requests.push({
      key: modelKey,
      request: options => fetchTropicalModelsFile(cycloneId, selected, options),
      check: data => checkModelFile(data, cycloneId, selected),
    });
  }
  const ensembleEntry = ensembleInfo && ensembleInfo.status === "ok"
    ? ensembleInfo.cycles.find(item => item.cycle === selected) : null;
  const ensembleKeys = {};
  for (const model of ENSEMBLES) {
    if (!ensembleOn.includes(model) || !ensembleEntry || !ensembleEntry.models[model]) continue;
    const key = ensembleFileKey(cycloneId, selected, model);
    ensembleKeys[model] = key;
    requests.push({
      key,
      request: options => fetchTropicalEnsembleFile(cycloneId, selected, model, options),
      check: data => checkEnsembleFile(data, cycloneId, selected, model),
    });
  }
  useCachedFiles(cache, requests);

  // Plain values below, so the memo keeps one object while nothing changed (11f review suggestion 3).
  let modelStatus = null;
  let modelFile = null;
  if (modelsEnabled) {
    if (!modelInfo || resolving) modelStatus = "loading";
    else if (modelInfo.status !== "ok") modelStatus = modelInfo.status;
    else if (!modelKey) modelStatus = "nocycle";
    else {
      const file = settled(cache, modelKey);
      modelFile = file.done ? file.value : null;
      modelStatus = !file.done ? "loading" : file.value === null ? "unavailable" : "ok";
    }
  }
  const ensembleIndexStatus = !ensembleEnabled ? null : !ensembleIndex.done ? (wantEnsembleIndex ? "loading" : "idle")
    : ensembleInfo.status;
  const ensembleStates = ENSEMBLES.map(model => {
    if (!ensembleEnabled || !ensembleOn.includes(model)) return ["off", null];
    if (ensembleIndexStatus !== "ok") return [ensembleIndexStatus === "idle" ? "loading" : ensembleIndexStatus, null];
    if (!ensembleKeys[model]) return ["nocycle", null];
    const file = settled(cache, ensembleKeys[model]);
    if (!file.done) return ["loading", null];
    return file.value === null ? ["unavailable", null] : ["ok", file.value];
  });
  const flat = ensembleStates.flat();
  const optionsKey = choice.options.join(",");
  // Per Ensemble, the cycles that do have it, so "not in this cycle" can say where it is (no automatic switch).
  const availableKey = ENSEMBLES.map(model => (ensembleInfo && ensembleInfo.status === "ok"
    ? ensembleInfo.cycles.filter(item => item.models[model]).map(item => item.cycle).join(",") : "")).join("|");

  const cycles = useMemo(() => ({
    options: optionsKey ? optionsKey.split(",") : [], selected, latest: choice.latest,
    requestedMissing: choice.requestedMissing && cyclesSettled, settled: cyclesSettled,
  }), [optionsKey, selected, choice.latest, choice.requestedMissing, cyclesSettled]);
  const models = useMemo(() => {
    if (modelStatus === null) return null;
    return modelStatus === "ok" ? { status: "ok", cycle: selected, file: modelFile } : { status: modelStatus };
  }, [modelStatus, modelFile, selected]);
  const ensemble = useMemo(() => {
    if (ensembleIndexStatus === null) return null;
    const byModel = {};
    const available = availableKey.split("|");
    ENSEMBLES.forEach((model, i) => {
      const [status, file] = [flat[i * 2], flat[i * 2 + 1]];
      if (status === "ok") byModel[model] = { status, file };
      else if (status === "nocycle") byModel[model] = { status, available: available[i] ? available[i].split(",") : [] };
      else byModel[model] = { status };
    });
    return { index: ensembleIndexStatus, models: byModel };
    // `flat` is spread so the memo compares each status and file, not the new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensembleIndexStatus, availableKey, ...flat]);
  return { cycles, models, ensemble };
}
