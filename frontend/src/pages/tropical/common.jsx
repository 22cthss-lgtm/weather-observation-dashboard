// Shared pieces of the /tropical overview and storm pages (design.md 7.5, 7.6).
import { Link } from "react-router-dom";
import { REQUIRED_AGENCIES } from "../../tropical/status";
import { SITE_IMAGE_LINKS } from "../../tropical/imagery";
import { ENSEMBLE_LAYERS_ENABLED, MODEL_LAYERS_ENABLED } from "../../tropical/features";
import {
  AGENCY_LABELS, AGENCY_SHORT, formatDualTime, formatPosition, formatPressure, formatWind, textOrNull,
} from "../../tropical/format";

export function DualTime({ stamp, missing = "—" }) {
  const time = formatDualTime(stamp);
  if (!time) return <>{missing}</>;
  return (
    <span className="tc-time">
      <span>{time.utc}</span>
      <span>臺灣 {time.taipei}</span>
    </span>
  );
}

export const INTENSITY_NOTE = "強度不可跨機構比較：JTWC 為 1 分鐘平均風速，JMA 與 CWA 為 10 分鐘平均風速；"
  + "分類為各機構原文，未做對照。本頁不排序、不平均、不換算各機構的數值。";

/** Product names in the NOAA and ECMWF lines, following each build switch on its own (design.md 11h H17 (1), 11i). */
export function modelProductNames(models, ensemble) {
  const join = parts => parts.filter(Boolean).join(" 與 ");
  return {
    noaa: join([models && "數值模式 GFS、AIGFS", ensemble && "Ensemble GEFS、AIGEFS"]),
    ecmwf: join([models && "數值模式 IFS、AIFS", ensemble && "Ensemble IFS ENS、AIFS ENS"]),
  };
}

function External({ href, children = href }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const JMA_XML_PAGE = "https://xml.kishou.go.jp/xmlpull.html";

/**
 * Final attribution (design.md 7.6, 11i), checked word by word against the terms captured in
 * .runtime/tc-source-verification/terms/, s2/out/terms/ and .runtime/s11-imagery/terms/.
 * The ECMWF wording is copied from the ECMWF terms ("services created with this ECMWF data product").
 * @param models / ensemble follow the two build switches (VITE_TROPICAL_MODEL_LAYERS / _ENSEMBLE_LAYERS).
 */
export function Attribution({ models = MODEL_LAYERS_ENABLED, ensemble = Boolean(ENSEMBLE_LAYERS_ENABLED) }) {
  const anyModel = Boolean(models || ensemble);
  const names = modelProductNames(models, ensemble);
  return (
    <footer className="tc-attribution" aria-labelledby="tc-attribution-title">
      <h3 id="tc-attribution-title">資料來源與署名</h3>
      <ul>
        {/* Sentences are kept on one line each: a JSX line break inside Chinese text would become a space. */}
        <li>
          <strong>JTWC：</strong>
          {"本頁含美國聯合颱風警報中心（JTWC）資料，該資料不受著作權保護（17 U.S.C. §403），公眾可自由使用；警報圖由瀏覽器直接自 JTWC 網站載入。"}
          {"JTWC 產品主要供美國政府機關使用，一般使用者請以本國氣象機關或世界氣象組織區域專業氣象中心的熱帶氣旋資訊為準（臺灣以中央氣象署為準）。"}
          {"本站未修改其內容後宣稱著作權。"}
        </li>
        <li>
          <strong>JMA：</strong>
          {"出典：気象庁ホームページ（"}<External href={JMA_XML_PAGE} />{"）。"}
          {"気象庁「気象庁防災情報XMLフォーマット形式電文の公開（PULL型）」（"}<External href={JMA_XML_PAGE} />{"）を加工して作成："}
          {"本頁的表格與路徑圖由本站以氣象廳的颱風解析・預報電文加工作成，並非日本政府製作。"}
        </li>
        <li>
          <strong>CWA：</strong>
          {"提供機關／交通部中央氣象署 颱風消息與警報-熱帶氣旋路徑（W-C0034-005）。"}
          {"此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。"}
          {"（"}<External href="https://data.gov.tw/license">政府資料開放授權條款</External>{"）"}
          {"CWA 風速的平均期間依慣例視為 10 分鐘，尚未經官方文件確認。"}
        </li>
        {anyModel ? (
          <>
            <li>
              <strong>NOAA／NWS（{names.noaa}）：</strong>
              {"本頁含美國國家氣象局（NOAA／NWS）的熱帶氣旋追蹤資料，該資料不受著作權保護（17 U.S.C. §403）。"}
              {"本站與 NOAA／NWS 無關，亦未獲其背書；資料經本站轉換格式與篩選，不是官方資料的原樣呈現。"}
            </li>
            <li>
              <strong>ECMWF（{names.ecmwf}）：</strong>
              {'Copyright statement: Copyright "This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)". '}
              {"Source "}<External href="https://www.ecmwf.int/">www.ecmwf.int</External>{" "}
              {"Licence Statement: This ECMWF data is published under a Creative Commons Attribution 4.0 International (CC BY 4.0). "}
              <External href="https://creativecommons.org/licenses/by/4.0/" />{" "}
              {"Disclaimer: ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use. "}
              {`修改說明：本站已修改原始資料——由 BUFR 轉換為 JSON、只保留西北太平洋已識別的熱帶系統、只保留路徑欄位（位置、中心氣壓、10 m 最大風${ensemble ? "，以及 Ensemble 成員編號與原始類型代碼" : ""}）。`}
            </li>
            <li>
              {`${models && ensemble ? "數值模式與 Ensemble 成員" : models ? "數值模式" : "Ensemble 成員"}路徑是模式的原始輸出，非官方預報，亦非本站預報；模式風速是 10 m 最大風，沒有平均期間，不可與機構的強度比較。`}
            </li>
          </>
        ) : null}
        <li>
          <strong>底圖：</strong>陸地輪廓取自 Natural Earth（公有領域；Made with Natural Earth.），經本站裁切與簡化。
        </li>
        <li>{INTENSITY_NOTE}</li>
      </ul>
    </footer>
  );
}

/** Links to the site's existing image pages (design.md 11i); those pages are not changed. */
export function SiteImageLinks() {
  return (
    <section className="tc-section tc-site-links" aria-labelledby="tc-site-links-title">
      <h3 id="tc-site-links-title">相關環境圖資（本站既有頁面）</h3>
      <p className="tc-note">
        以下是本站其他頁面的區域或全域環境圖，不是針對個別熱帶系統的產品；各圖的來源與時間以該頁顯示為準。
      </p>
      <ul className="tc-plain-list">
        {SITE_IMAGE_LINKS.map(item => (
          <li key={item.to}><Link to={item.to}>{item.label}</Link>：{item.description}</li>
        ))}
      </ul>
    </section>
  );
}

export function Banner({ display, index }) {
  if (display.state === "UNAVAILABLE") {
    return (
      <div className="tc-banner tc-banner-unavailable" role="alert">
        <strong>熱帶系統資料暫時無法取得</strong>
        <p>這不代表目前沒有熱帶系統，請稍後重新整理，或參考中央氣象署的颱風消息。</p>
      </div>
    );
  }
  const noActive = !display.hasActive;
  let detail;
  if (display.indexStatus === "PARTIAL") {
    detail = noActive
      ? "部分來源無法取得，無法確認是否有活躍系統。"
      : "部分來源無法取得：以下為取得成功的來源與先前保存的資料，可能不完整。";
  } else if (display.indexStatus === "OK_NO_STORMS") {
    detail = "目前無活躍熱帶系統。";
  } else {
    detail = "以下為各機構目前發報中的系統。";
  }

  if (display.state === "STALE") {
    const stale = display.staleSources;
    return (
      <div className="tc-banner tc-banner-stale" role="alert">
        <strong>資料可能已過期，目前狀況無法確認</strong>
        <ul className="tc-stale-list">
          {REQUIRED_AGENCIES.map(agency => (
            <li key={agency}>
              {AGENCY_SHORT[agency]} 最後確認時間：
              <DualTime stamp={index.sources[agency].last_ok_at} missing="尚無成功紀錄" />
              {stale.includes(agency) ? <span className="tc-flag">已過期</span> : null}
            </li>
          ))}
        </ul>
        <p>最後一次確認時的狀態：{display.indexStatus === "OK_NO_STORMS"
          ? "當時沒有活躍熱帶系統（已過期，不代表現在）。"
          : display.indexStatus === "OK_WITH_STORMS"
            ? "當時各機構發報中的系統如下（已過期，可能已有變化）。"
            : detail}</p>
      </div>
    );
  }
  const tone = display.state === "PARTIAL" ? "tc-banner-partial" : "tc-banner-ok";
  return (
    <div className={`tc-banner ${tone}`} role="status">
      <strong>{detail}</strong>
    </div>
  );
}

export function AgencySummary({ agency, summary, children = null }) {
  const position = formatPosition(summary.lat, summary.lon);
  const wind = formatWind(agency, summary.max_wind);
  const pressure = formatPressure(summary.pressure_hpa);
  const category = textOrNull(summary.category);
  return (
    <section className="tc-agency" aria-label={AGENCY_LABELS[agency]}>
      <h5>{AGENCY_LABELS[agency]}</h5>
      <dl>
        <dt>機構判定</dt>
        <dd>{summary.active === true ? "活躍" : summary.active === false ? "已不視為活躍" : "—"}</dd>
        <dt>分析時間</dt>
        <dd><DualTime stamp={summary.analysis_time} /></dd>
        <dt>位置</dt>
        <dd>{position || "—"}</dd>
        <dt>最大風速</dt>
        <dd>{wind || "—"}</dd>
        <dt>中心氣壓</dt>
        <dd>{pressure || "—"}</dd>
        {category ? <><dt>機構分類（原文）</dt><dd>{category}</dd></> : null}
        {children}
      </dl>
    </section>
  );
}
