// Forecast tab: official tracks (design.md 7.2–7.5) and, behind their build switches, deterministic
// model tracks (design.md 7.7, 11e E3/E4, 11f) and Ensemble members (1.8, 1.9, 7.5, 11h) as
// separate layers, all for one chosen cycle (11h H3).
import { Component, lazy, Suspense, useMemo, useState } from "react";
import { AGENCIES } from "../../tropical/status";
import {
  ANALYSIS_KEY, buildTimeline, buildTracks, defaultToggles, drawables, entriesAt, findNode, initTimes,
} from "../../tropical/tracks";
import {
  AGENCY_LABELS, AGENCY_SHORT, formatDualTime, formatGust, formatMovement, formatNote, formatPosition,
  formatPressure, formatProbabilityCircle, formatRadii, formatTau, formatWind, textOrNull,
} from "../../tropical/format";
import {
  MODELS, MODEL_COLORS, MODEL_INFO, MODEL_LEGEND, buildModelTracks, defaultModelToggles, enabledModelTracks,
  cycleTime, findModelNode, formatModelWind, isModelDataStale, stampOf,
} from "../../tropical/models";
import {
  ENSEMBLES, ENSEMBLE_COLORS, ENSEMBLE_INFO, ENSEMBLE_NOTE, buildEnsembleTracks, defaultEnsembleFocus,
  defaultEnsembleToggles, findEnsembleNode, formatMemberCount,
} from "../../tropical/ensemble";
import { DualTime, INTENSITY_NOTE } from "./common";

// Leaflet, its CSS and the coastline load only when this tab opens (design.md 7.1, 7.2).
const TrackMap = lazy(() => import("./TrackMap"));

export const AGENCY_COLORS = { jtwc: "#d9480f", jma: "#1864ab", cwa: "#2b8a3e" };
const MAP_COLORS = { ...AGENCY_COLORS, ...MODEL_COLORS, ...ENSEMBLE_COLORS };

const LAYER_LABELS = {
  past: "過去路徑",
  forecast: "最新分析與預報路徑",
  circles: "機率圓（JMA 預報圓、CWA 70% 半徑）",
  radii: "最新分析的風圈",
};

const KIND_LABELS = { past: "過去路徑點", fix: "最新分析", forecast: "預報點" };

class MapBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <p className="tc-unavailable" role="note">地圖暫時無法載入；下方的時間軸與節點資料仍可使用。</p>;
    return this.props.children;
  }
}

function statusNote(track) {
  if (track.analysisStatus === "loading" || track.forecastStatus === "loading") return ["讀取中…"];
  if (track.analysisStatus === "missing" && track.forecastStatus === "missing") return ["沒有這個系統的資料"];
  const notes = [];
  if (track.analysisStatus === "unavailable" || track.analysisStatus === "invalid") notes.push("分析資料暫時無法取得");
  if (track.analysisStatus === "missing") notes.push("沒有分析資料");
  if (track.forecastStatus === "unavailable" || track.forecastStatus === "invalid") notes.push("預報資料暫時無法取得");
  if (track.forecastStatus === "missing") notes.push("沒有預報資料");
  if (track.forecastStatus === "ok" && !track.points.length) notes.push("這一報沒有預報點");
  return notes;
}

function shortTime(stamp) {
  const time = formatDualTime(stamp);
  return time ? `${time.utc.slice(5)}（臺灣 ${time.taipei.slice(5)}）` : "—";
}

function InitTimes({ tracks, modelInit, ensembleOnly = false }) {
  const withForecast = tracks.filter(track => track.points.length);
  const official = initTimes(tracks);
  const differ = official.length > 1;
  const modelDiffers = Boolean(modelInit) && official.some(time => time !== modelInit);
  return (
    <section className="tc-init" aria-labelledby="tc-init-title">
      <h4 id="tc-init-title">各機構的起報時間</h4>
      {withForecast.length ? (
        <ul className="tc-plain-list">
          {withForecast.map(track => (
            <li key={track.agency}>
              <span className="tc-swatch" style={{ background: AGENCY_COLORS[track.agency] }} aria-hidden="true" />
              {AGENCY_SHORT[track.agency]}：起報 <DualTime stamp={track.initTime} />；發布 <DualTime stamp={track.forecastIssuedAt} />
              {textOrNull(track.forecastBulletin) ? `；報次 ${track.forecastBulletin}` : ""}
            </li>
          ))}
        </ul>
      ) : <p className="status-message">目前沒有任何機構的預報點。</p>}
      {differ ? (
        <p className="tc-hint" role="note">
          各機構的起報時間不同：同一有效時間的位置來自不同時刻起報的預報，不是同一時刻的比較。
        </p>
      ) : null}
      {modelInit ? (
        <p className="status-message">
          {ensembleOnly ? "已開啟的 Ensemble 起報時間（cycle）" : "已開啟的數值模式起報時間（cycle）"}：<DualTime stamp={modelInit} />
        </p>
      ) : null}
      {modelDiffers ? (
        <p className="tc-hint" role="note">
          {ensembleOnly ? "已開啟的 Ensemble 起報時間（cycle）" : "已開啟的數值模式起報時間（cycle）"}與官方起報時間不同：同一有效時間的位置來自不同時刻起報的資料，不是同一時刻的比較。
        </p>
      ) : null}
    </section>
  );
}

function Timeline({ timeline, tracks, modelTracks, memberTracks, selectedKey, onSelectKey, onSelectNode }) {
  const steps = [timeline.analysis, ...timeline.ticks];
  const entries = selectedKey === null ? [] : entriesAt(timeline, selectedKey);
  const shown = tracks.filter(track => track.fix || track.points.length);
  return (
    <section className="tc-timeline" aria-labelledby="tc-timeline-title">
      <h4 id="tc-timeline-title">有效時間軸</h4>
      <p className="status-message">
        刻度是各機構實際的預報有效時間（UTC），沒有節點的時刻不補值。
        {modelTracks.length ? "已開啟的數值模式也加入它們實際輸出的時刻。" : null}
        {memberTracks.length ? "單獨查看的 Ensemble 成員也加入它的時刻；顯示全部成員時不加入刻度。" : null}
      </p>
      <div className="tc-ticks" role="group" aria-label="選擇有效時間">
        {steps.map(step => {
          const agencies = new Set(step.entries.map(entry => entry.agency));
          const models = new Set(step.entries.map(entry => entry.model).filter(Boolean));
          const members = step.entries.filter(entry => entry.ensemble);
          return (
            <button key={step.key} type="button" className="tc-tick" aria-pressed={selectedKey === step.key}
              onClick={() => onSelectKey(selectedKey === step.key ? null : step.key)}>
              <span className="tc-tick-time">
                {step.key === ANALYSIS_KEY ? "最新分析" : shortTime(step.time)}
              </span>
              <span className="tc-tick-agencies">
                {AGENCIES.filter(agency => agencies.has(agency)).map(agency => (
                  <span key={agency} className="tc-tick-agency" style={{ color: AGENCY_COLORS[agency] }}>
                    {AGENCY_SHORT[agency]}
                  </span>
                ))}
                {MODELS.filter(model => models.has(model)).map(model => (
                  <span key={model} className="tc-tick-agency tc-tick-model" style={{ color: MODEL_COLORS[model] }}>
                    {MODEL_INFO[model].short}
                  </span>
                ))}
                {members.map(entry => (
                  <span key={entry.nodeId} className="tc-tick-agency tc-tick-model"
                    style={{ color: ENSEMBLE_COLORS[entry.ensemble] }}>
                    {ENSEMBLE_INFO[entry.ensemble].short} {entry.member}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {selectedKey !== null ? (
        <div className="tc-tick-detail" aria-live="polite">
          {selectedKey !== ANALYSIS_KEY && new Set(entries.map(entry => entry.initTime)).size > 1 ? (
            <p className="tc-hint">這一刻的節點來自不同的起報時間，不是同一時刻起報的比較。</p>
          ) : null}
          <p>
            {selectedKey === ANALYSIS_KEY
              ? "最新分析：各機構的分析時間各自不同，逐一列出。"
              : <>有效時間：<DualTime stamp={selectedKey} /></>}
          </p>
          <ul className="tc-plain-list">
            {shown.map(track => {
              const entry = entries.find(item => item.agency === track.agency);
              return (
                <li key={track.agency}>
                  <span className="tc-swatch" style={{ background: AGENCY_COLORS[track.agency] }} aria-hidden="true" />
                  {entry ? (
                    <>
                      {AGENCY_SHORT[track.agency]}{" "}
                      {entry.tauH === null
                        ? <>分析時間 <DualTime stamp={entry.time} /></>
                        : <>{formatTau(entry.tauH)}（起報 {shortTime(entry.initTime)}）</>}
                      {" "}
                      <button type="button" className="tc-link-button" onClick={() => onSelectNode(entry.nodeId)}>
                        查看節點
                      </button>
                    </>
                  ) : <>此時刻沒有 {AGENCY_SHORT[track.agency]} 的節點。</>}
                </li>
              );
            })}
            {selectedKey === ANALYSIS_KEY ? null : modelTracks.map(track => {
              const entry = entries.find(item => item.model === track.model);
              const short = MODEL_INFO[track.model].short;
              return (
                <li key={track.model}>
                  <span className="tc-swatch tc-swatch-model" style={{ borderColor: MODEL_COLORS[track.model] }}
                    aria-hidden="true" />
                  {entry ? (
                    <>
                      {short} 起報後 {formatTau(entry.tauH)}（cycle {shortTime(entry.initTime)}）{" "}
                      <button type="button" className="tc-link-button" onClick={() => onSelectNode(entry.nodeId)}>
                        查看節點
                      </button>
                    </>
                  ) : <>此時刻沒有 {short} 的節點。</>}
                </li>
              );
            })}
            {selectedKey === ANALYSIS_KEY ? null : memberTracks.map(track => {
              const entry = entries.find(item => item.ensemble === track.model && item.member === track.member);
              const name = memberLabel(track.model, track.member);
              return (
                <li key={`${track.model}:${track.member}`}>
                  <span className="tc-swatch" style={{ background: ENSEMBLE_COLORS[track.model] }} aria-hidden="true" />
                  {entry ? (
                    <>
                      {name} 起報後 {formatTau(entry.tauH)}（cycle {shortTime(entry.initTime)}）{" "}
                      <button type="button" className="tc-link-button" onClick={() => onSelectNode(entry.nodeId)}>
                        查看節點
                      </button>
                    </>
                  ) : <>此時刻沒有 {name} 的節點。</>}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ModelNodeDetail({ node }) {
  const info = MODEL_INFO[node.model];
  return (
    <section className="tc-agency tc-node" aria-label="節點細節">
      <h5>{info.label}｜數值模式節點</h5>
      <p className="tc-note">{MODEL_LEGEND}</p>
      <dl>
        <dt>提供者</dt>
        <dd>{info.provider}</dd>
        <dt>模式起報時間（cycle）</dt>
        <dd><DualTime stamp={node.initTime} /></dd>
        <dt>時效</dt>
        <dd>起報後 {formatTau(node.tauH)}</dd>
        <dt>有效時間</dt>
        <dd><DualTime stamp={node.time} /></dd>
        <dt>中心位置</dt>
        <dd>{formatPosition(node.lat, node.lon) || "—"}</dd>
        <dt>中心氣壓</dt>
        <dd>{formatPressure(node.pressure) || "—"}</dd>
        <dt>風速</dt>
        <dd>{formatModelWind(node.wind, node.windUnit) || "—"}</dd>
      </dl>
      <p className="tc-note">模式風速是模式輸出的 10 m 最大風，與機構的平均風速定義不同，不可比較。</p>
    </section>
  );
}

function EnsembleNodeDetail({ node }) {
  const info = ENSEMBLE_INFO[node.model];
  return (
    <section className="tc-agency tc-node" aria-label="節點細節">
      <h5>{info.label}｜Ensemble 成員 {node.member} 的節點</h5>
      <p className="tc-note">{MODEL_LEGEND}{ENSEMBLE_NOTE}</p>
      <dl>
        <dt>提供者</dt>
        <dd>{info.provider}</dd>
        <dt>成員代碼（來源原樣）</dt>
        <dd>{node.member}</dd>
        {node.memberType !== null ? (
          <><dt>ensembleForecastType（來源原始代碼，未解讀）</dt><dd>{node.memberType}</dd></>
        ) : null}
        <dt>模式起報時間（cycle）</dt>
        <dd><DualTime stamp={node.initTime} /></dd>
        <dt>時效</dt>
        <dd>起報後 {formatTau(node.tauH)}</dd>
        <dt>有效時間</dt>
        <dd><DualTime stamp={node.time} /></dd>
        <dt>中心位置</dt>
        <dd>{formatPosition(node.lat, node.lon) || "—"}</dd>
        <dt>中心氣壓</dt>
        <dd>{formatPressure(node.pressure) || "—"}</dd>
        <dt>風速</dt>
        <dd>{formatModelWind(node.wind, node.windUnit) || "—"}</dd>
      </dl>
      <p className="tc-note">模式風速是模式輸出的 10 m 最大風，與機構的平均風速定義不同，不可比較。</p>
    </section>
  );
}

function cycleLabel(cycle) {
  const time = cycleTime(cycle);
  const dual = time === null ? null : formatDualTime(stampOf(time));
  return dual ? `${dual.utc}（臺灣 ${dual.taipei}）` : cycle;
}

/** "11-22 00:00 UTC" for a cycle, used in short notes. */
function shortCycle(cycle) {
  const time = cycleTime(cycle);
  return time === null ? cycle : `${stampOf(time).slice(5, 16).replace("T", " ")} UTC`;
}

function CycleSelector({ cycles, ignored, onSelect }) {
  const { options, selected, latest } = cycles;
  return (
    <fieldset className="tc-layers tc-cycles">
      <legend>數值模式與 Ensemble 的起報時間（cycle）</legend>
      {options.length > 1 ? (
        <label className="tc-check">
          選擇 cycle：
          <select value={selected ?? ""} onChange={event => onSelect(event.target.value)}>
            {[...options].reverse().map(cycle => (
              <option key={cycle} value={cycle}>{cycleLabel(cycle)}{cycle === latest ? "（預設）" : ""}</option>
            ))}
          </select>
        </label>
      ) : null}
      {options.length === 1 ? <p className="status-message">目前只有一個 cycle：{cycleLabel(options[0])}</p> : null}
      {!options.length && cycles.settled ? <p className="status-message">目前沒有可選的 cycle。</p> : null}
      {ignored && options.length ? <p className="tc-hint" role="note">網址中的 cycle 格式不正確，已改為顯示預設的 cycle。</p> : null}
      {cycles.requestedMissing && options.length ? (
        <p className="tc-hint" role="note">網址指定的 cycle 不在目前的資料中，已改為顯示預設的 cycle。</p>
      ) : null}
      <p className="tc-note">
        確定性模式與已開啟的 Ensemble 都顯示所選的 cycle（同一個起報時間）；官方路徑不隨 cycle 改變。
      </p>
    </fieldset>
  );
}

const ENSEMBLE_STATUS_NOTES = {
  loading: "讀取中…",
  unavailable: "此資料暫時無法取得",
  none: "沒有這個系統的 Ensemble 資料",
  nocycle: "所選的 cycle 沒有此 Ensemble",
};

function memberLabel(model, member) {
  return `${ENSEMBLE_INFO[model].short} 成員 ${member}`;
}

function EnsembleLayers({ ensemble, toggles, onToggle, focus, onFocus }) {
  let message = null;
  if (ensemble.index === "loading") message = <p className="status-message">Ensemble 資料讀取中…</p>;
  else if (ensemble.index === "unavailable") {
    message = <p className="tc-unavailable" role="note">Ensemble 資料暫時無法取得；官方路徑與確定性模式不受影響。</p>;
  } else if (ensemble.index === "none") message = <p className="status-message">目前沒有這個系統的 Ensemble 資料。</p>;
  return (
    <fieldset className="tc-layers tc-models tc-ensembles">
      <legend>Ensemble 成員路徑（原始輸出）</legend>
      <p className="tc-note">
        <strong>{MODEL_LEGEND}{ENSEMBLE_NOTE}</strong>
        本站不畫外圍範圍、不計算機率，也不取平均。各 Ensemble 預設關閉，開啟後顯示全部成員，可選擇單一成員或點選地圖上的線條。
      </p>
      {message}
      {ENSEMBLES.map(model => {
        const info = ENSEMBLE_INFO[model];
        const state = ensemble.models[model];
        const on = Boolean(toggles[model]);
        const file = state.status === "ok" ? state.file : null;
        const focused = file ? focus[model] : null;
        const focusedMember = focused ? file.members.find(member => member.m === focused) : null;
        let note = null;
        if (on && !file) note = ENSEMBLE_STATUS_NOTES[state.status] ?? null;
        if (on && state.status === "nocycle") {
          note = state.available && state.available.length
            ? `所選的 cycle 沒有此 Ensemble；有此 Ensemble 的 cycle：${state.available.map(shortCycle).join("、")}`
            : "目前沒有這個系統的此 Ensemble 資料";
        }
        if (on && file) {
          note = formatMemberCount(file.members.length, file.membersExpected);
          if (file.dropped) note += `；另有 ${file.dropped} 筆成員資料不完整，未顯示`;
        }
        return (
          <div key={model} className="tc-layer-row tc-ensemble-row">
            <label className="tc-check">
              <input type="checkbox" checked={on} onChange={() => onToggle(model)} />
              <span className="tc-swatch" style={{ background: info.color }} aria-hidden="true" />
              {info.label}
              {note ? <span className="tc-check-note">（{note}）</span> : null}
            </label>
            {on && file && file.members.length ? (
              <label className="tc-check">
                顯示：
                <select aria-label={`${info.short} 顯示的成員`} value={focusedMember ? focused : ""}
                  onChange={event => onFocus(model, event.target.value || null)}>
                  <option value="">全部成員</option>
                  {file.members.map(member => (
                    <option key={member.m} value={member.m}>成員 {member.m}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {focusedMember ? (
              <span className="tc-check-note">
                {memberLabel(model, focused)}：{focusedMember.track.length} 個節點，起報後{" "}
                {formatTau(focusedMember.track[0][0])} 至 {formatTau(focusedMember.track[focusedMember.track.length - 1][0])}
              </span>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

const MODEL_STATUS_NOTES = { missing: "這個 cycle 沒有此模式", invalid: "此模式的資料暫時無法取得" };

function ModelLayers({ models, modelTracks, toggles, onToggle, storm, now, latestCycle }) {
  let message = null;
  if (models.status === "loading") message = <p className="status-message">數值模式資料讀取中…</p>;
  else if (models.status === "unavailable") {
    message = <p className="tc-unavailable" role="note">數值模式資料暫時無法取得；官方路徑不受影響。</p>;
  } else if (models.status === "none") message = <p className="status-message">目前沒有這個系統的數值模式資料。</p>;
  else if (models.status === "nocycle") message = <p className="status-message">所選的 cycle 沒有確定性模式資料。</p>;
  const ok = models.status === "ok";
  // Freshness is about the newest cycle (11f F8), whichever cycle is being looked at.
  const latestTime = latestCycle ? cycleTime(latestCycle) : null;
  const stale = (ok || models.status === "nocycle") && latestTime !== null
    && isModelDataStale(storm, stampOf(latestTime), now);
  return (
    <fieldset className="tc-layers tc-models">
      <legend>數值模式路徑（原始輸出）</legend>
      <p className="tc-note"><strong>{MODEL_LEGEND}</strong>各模式預設關閉，可自行開啟比較。</p>
      {message}
      {ok ? <p className="status-message">模式起報時間（cycle）：<DualTime stamp={models.file.initTime} /></p> : null}
      {stale ? (
        <p className="tc-hint" role="note">模式資料可能未更新：最新的模式起報時間距今已超過 18 小時。</p>
      ) : null}
      <div className="tc-layer-row">
        {MODELS.map(model => {
          const track = modelTracks.find(item => item.model === model);
          const has = Boolean(track && track.points.length);
          const note = track ? MODEL_STATUS_NOTES[track.status] : null;
          return (
            <label key={model} className="tc-check">
              <input type="checkbox" checked={has && toggles[model]} disabled={!has} onChange={() => onToggle(model)} />
              <span className="tc-swatch tc-swatch-model" style={{ borderColor: MODEL_COLORS[model] }} aria-hidden="true" />
              {MODEL_INFO[model].label}
              {note ? <span className="tc-check-note">（{note}）</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function NodeDetail({ node, track }) {
  if (node && node.kind === "model") return <ModelNodeDetail node={node} />;
  if (node && node.kind === "ensemble") return <EnsembleNodeDetail node={node} />;
  if (!node) return <p className="status-message">點選地圖上的節點，或在時間軸選擇時刻後按「查看節點」，可看到該點的細節。</p>;
  const category = textOrNull(node.category);
  const circle = formatProbabilityCircle(node.agency, node.probabilityCircle);
  const note = formatNote(node.note);
  const radii = node.radii.map(formatRadii).filter(Boolean);
  const movement = node.kind === "fix" ? formatMovement(node.movement) : null;
  const gust = formatGust(node.gust);
  return (
    <section className="tc-agency tc-node" aria-label="節點細節">
      <h5>{AGENCY_LABELS[node.agency]}｜{KIND_LABELS[node.kind]}</h5>
      <dl>
        <dt>{node.kind === "forecast" ? "有效時間" : "分析時間"}</dt>
        <dd><DualTime stamp={node.time} /></dd>
        {node.kind === "forecast" ? (
          <>
            <dt>預報時效</dt>
            <dd>{formatTau(node.tauH)}（起報 <DualTime stamp={track.initTime} />）</dd>
          </>
        ) : null}
        <dt>中心位置</dt>
        <dd>{formatPosition(node.lat, node.lon) || "—"}</dd>
        <dt>最大風速</dt>
        <dd>{formatWind(node.agency, node.maxWind) || "—"}</dd>
        {gust ? <><dt>陣風</dt><dd>{gust}</dd></> : null}
        <dt>中心氣壓</dt>
        <dd>{formatPressure(node.pressure) || "—"}</dd>
        {category ? <><dt>機構分類（原文）</dt><dd>{category}</dd></> : null}
        {movement ? <><dt>移動</dt><dd>{movement}</dd></> : null}
        {circle ? <><dt>機率圓</dt><dd>{circle}</dd></> : null}
        {radii.length ? (
          <><dt>風圈</dt><dd><ul className="tc-plain-list">{radii.map(text => <li key={text}>{text}</li>)}</ul></dd></>
        ) : null}
        {note ? <><dt>機構註記</dt><dd>{note}</dd></> : null}
      </dl>
    </section>
  );
}

const NO_ENSEMBLE_FILES = Object.fromEntries(ENSEMBLES.map(model => [model, null]));

/**
 * @param models null when the build switch is off (no model section at all), else from
 *   useForecastFiles: {status: "loading" | "unavailable" | "none" | "nocycle"} or {status: "ok", cycle, file}
 * @param ensemble null when the Ensemble switch is off, else useForecastFiles' Ensemble state
 * @param cycles the cycle choice (useForecastFiles); onSelectCycle changes the `cycle` query parameter
 * @param ensembleToggles the Ensembles switched on (kept by the caller, which reads their files)
 * @param now the page clock (ms), used only for the model freshness hint
 */
export default function ForecastPanel({
  analysis, forecast, storm = null, now = null, models = null, ensemble = null, cycles = null, cycleIgnored = false,
  onSelectCycle = () => {}, ensembleToggles = null, onToggleEnsemble = () => {},
}) {
  const tracks = useMemo(() => buildTracks(analysis, forecast), [analysis, forecast]);
  const modelTracks = useMemo(() => buildModelTracks(models), [models]);
  const [toggles, setToggles] = useState(defaultToggles);
  const [modelToggles, setModelToggles] = useState(defaultModelToggles);
  const [chosenFocus, setFocus] = useState(defaultEnsembleFocus);
  const shownModels = useMemo(() => enabledModelTracks(modelTracks, modelToggles), [modelTracks, modelToggles]);
  const cycle = cycles ? cycles.selected : null;
  const ensembleOn = ensembleToggles || defaultEnsembleToggles();

  // Members of the Ensembles switched on and read for this cycle.
  const files = ensemble ? Object.fromEntries(ENSEMBLES.map(model => [model,
    ensembleOn[model] && ensemble.models[model].status === "ok" ? ensemble.models[model].file : null])) : NO_ENSEMBLE_FILES;
  const [gefsFile, aigefsFile, ifsEnsFile, aifsEnsFile] = ENSEMBLES.map(model => files[model]);
  const ensembleTracks = useMemo(() => [gefsFile, aigefsFile, ifsEnsFile, aifsEnsFile].flatMap(buildEnsembleTracks),
    [gefsFile, aigefsFile, ifsEnsFile, aifsEnsFile]);
  // A focus on a member this cycle does not have falls back to "all members".
  const focus = Object.fromEntries(ENSEMBLES.map(model => [model,
    ensembleTracks.some(track => track.model === model && track.member === chosenFocus[model]) ? chosenFocus[model] : null]));
  const focusKey = ENSEMBLES.map(model => focus[model] ?? "").join("|");
  const ensembleLines = useMemo(() => {
    const chosen = Object.fromEntries(focusKey.split("|").map((member, i) => [ENSEMBLES[i], member || null]));
    return ensembleTracks.map(track => ({
      ...track,
      focused: chosen[track.model] === track.member,
      dimmed: chosen[track.model] !== null && chosen[track.model] !== track.member,
    }));
  }, [ensembleTracks, focusKey]);
  const memberTracks = useMemo(() => ensembleLines.filter(line => line.focused), [ensembleLines]);

  const timeline = useMemo(() => buildTimeline(tracks, shownModels, memberTracks), [tracks, shownModels, memberTracks]);
  const [chosenKey, setSelectedKey] = useState(null);
  const [chosenNode, setChosenNode] = useState(null); // {id, cycle}
  // A tick or node that belonged to a layer just switched off, or to another cycle, is no longer selected.
  const selectedKey = chosenKey === null || chosenKey === ANALYSIS_KEY
    || timeline.ticks.some(tick => tick.key === chosenKey) ? chosenKey : null;
  const findAny = nodeId => findNode(tracks, nodeId) || findModelNode(shownModels, nodeId)
    || findEnsembleNode(memberTracks, nodeId);
  let selectedNode = chosenNode ? findAny(chosenNode.id) : null;
  if (selectedNode && (selectedNode.kind === "model" || selectedNode.kind === "ensemble") && chosenNode.cycle !== cycle) {
    selectedNode = null; // model node ids repeat across cycles
  }
  const selectedNodeId = selectedNode ? chosenNode.id : null;
  const items = useMemo(() => drawables(tracks, toggles, selectedKey, selectedNodeId, shownModels, ensembleLines),
    [tracks, toggles, selectedKey, selectedNodeId, shownModels, ensembleLines]);
  const selectedTrack = selectedNode && selectedNode.agency
    ? tracks.find(track => track.agency === selectedNode.agency) : null;
  const modelInit = shownModels.length ? shownModels[0].initTime : ensembleTracks.length ? ensembleTracks[0].initTime : null;

  const selectNode = nodeId => {
    const found = findAny(nodeId);
    setChosenNode({ id: nodeId, cycle });
    if (found) {
      setSelectedKey(found.kind === "fix" ? ANALYSIS_KEY
        : found.kind === "forecast" || found.kind === "model" || found.kind === "ensemble" ? found.time : null);
    }
  };
  const forgetSelection = prefix => {
    if (chosenNode && chosenNode.id.startsWith(prefix)) setChosenNode(null);
  };
  const toggle = (group, key) => setToggles(current => ({
    ...current, [group]: { ...current[group], [key]: !current[group][key] },
  }));
  const toggleModel = model => {
    const next = { ...modelToggles, [model]: !modelToggles[model] };
    setModelToggles(next);
    if (next[model]) return;
    // Forget a selection that belonged to the model switched off, so switching it on again does
    // not bring it back.
    forgetSelection(`model:${model}:`);
    if (chosenKey !== null && chosenKey !== ANALYSIS_KEY) {
      const remaining = buildTimeline(tracks, enabledModelTracks(modelTracks, next), memberTracks);
      if (!remaining.ticks.some(tick => tick.key === chosenKey)) setSelectedKey(null);
    }
  };
  // Choosing "all members" or another member forgets a node of this Ensemble, so it does not come back.
  const focusMember = (model, member) => {
    setFocus(current => ({ ...current, [model]: member }));
    forgetSelection(`ens:${model}:`);
    if (chosenKey !== null && chosenKey !== ANALYSIS_KEY) {
      const rest = memberTracks.filter(track => track.model !== model);
      const chosen = member ? ensembleTracks.filter(track => track.model === model && track.member === member) : [];
      const remaining = buildTimeline(tracks, shownModels, [...rest, ...chosen]);
      if (!remaining.ticks.some(tick => tick.key === chosenKey)) setSelectedKey(null);
    }
  };
  const toggleEnsemble = model => {
    if (ensembleOn[model]) focusMember(model, null);
    onToggleEnsemble(model);
  };
  const selectCycle = next => {
    if (chosenNode && (chosenNode.id.startsWith("model:") || chosenNode.id.startsWith("ens:"))) setChosenNode(null);
    onSelectCycle(next);
  };

  return (
    <section className="tc-section" aria-labelledby="tc-tab-title">
      <h3 id="tc-tab-title" className="tc-visually-hidden">預報路徑</h3>
      {analysis === null && forecast === null ? (
        <p className="tc-unavailable" role="note">此系統的分析與預報資料暫時無法取得。</p>
      ) : null}
      <fieldset className="tc-layers">
        <legend>圖層</legend>
        <div className="tc-layer-row">
          {tracks.map(track => {
            const notes = statusNote(track);
            const has = Boolean(track.fix || track.points.length);
            return (
              <label key={track.agency} className="tc-check">
                <input type="checkbox" checked={toggles.agencies[track.agency]} disabled={!has}
                  onChange={() => toggle("agencies", track.agency)} />
                <span className="tc-swatch" style={{ background: AGENCY_COLORS[track.agency] }} aria-hidden="true" />
                {AGENCY_SHORT[track.agency]}
                {notes.length ? <span className="tc-check-note">（{notes.join("；")}）</span> : null}
              </label>
            );
          })}
        </div>
        <div className="tc-layer-row">
          {Object.entries(LAYER_LABELS).map(([layer, label]) => (
            <label key={layer} className="tc-check">
              <input type="checkbox" checked={toggles.layers[layer]} onChange={() => toggle("layers", layer)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      {(models || ensemble) && cycles ? (
        <CycleSelector cycles={cycles} ignored={cycleIgnored} onSelect={selectCycle} />
      ) : null}
      {models ? (
        <ModelLayers models={models} modelTracks={modelTracks} toggles={modelToggles} onToggle={toggleModel}
          storm={storm} now={now} latestCycle={cycles ? cycles.latest : null} />
      ) : null}
      {ensemble ? (
        <EnsembleLayers ensemble={ensemble} toggles={ensembleOn} onToggle={toggleEnsemble} focus={focus}
          onFocus={focusMember} />
      ) : null}
      <MapBoundary>
        <Suspense fallback={<div className="tc-map tc-map-loading" role="status">地圖載入中…</div>}>
          <TrackMap items={items} colors={MAP_COLORS} onSelectNode={selectNode} onSelectMember={focusMember}
            ready={analysis !== undefined && forecast !== undefined} />
        </Suspense>
      </MapBoundary>
      <ul className="tc-legend tc-plain-list">
        <li>實線：過去路徑；虛線：預報路徑；大圓點：最新分析。</li>
        <li>淡色圓：機構的機率圓（JMA 預報圓為颱風中心進入的機率範圍，CWA 為 70% 機率半徑），<strong>不是暴風範圍</strong>。</li>
        <li>扇形：最新分析的風圈（依機構門檻與單位）；只畫四象限或全域的風圈，其他形式只列在文字中。</li>
        <li>past_track 標為「本站累積」的機構，過去路徑只含本站開始觀察後的紀錄。</li>
        {models ? <li>點線與空心圓：數值模式路徑。<strong>{MODEL_LEGEND}</strong></li> : null}
        {ensemble ? (
          <li>細實線：Ensemble 各成員的路徑（點選線條可單獨查看該成員與它的節點）。<strong>{ENSEMBLE_NOTE}</strong></li>
        ) : null}
      </ul>
      <p className="tc-note">{INTENSITY_NOTE}</p>
      <InitTimes tracks={tracks} modelInit={modelInit} ensembleOnly={!shownModels.length && Boolean(modelInit)} />
      <Timeline timeline={timeline} tracks={tracks} modelTracks={shownModels} memberTracks={memberTracks}
        selectedKey={selectedKey} onSelectKey={key => { setSelectedKey(key); setChosenNode(null); }}
        onSelectNode={selectNode} />
      <NodeDetail node={selectedNode} track={selectedTrack} />
    </section>
  );
}
