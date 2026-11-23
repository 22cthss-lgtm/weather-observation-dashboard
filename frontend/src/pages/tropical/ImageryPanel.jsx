// Imagery tab: official images linked from the agencies' own sites, never stored here
// (plan 1.4 B, design.md 7.6, 11i). It only uses analysis.json, already read for the storm.
import { useState } from "react";
import { AGENCY_LABELS } from "../../tropical/format";
import { OFFICIAL_PAGES, jtwcGraphic } from "../../tropical/imagery";
import { DualTime, SiteImageLinks } from "./common";

function OfficialLink({ agency }) {
  const page = OFFICIAL_PAGES[agency];
  return <a href={page.href} target="_blank" rel="noreferrer">{page.label}</a>;
}

/**
 * Same behaviour as SourceImage.jsx (not imported: it lives in the main chunk): when the official
 * image cannot be loaded, say so and link the official site. The caller keys it by `src`.
 */
function OfficialImage({ src, alt, agency }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <p className="status-message" role="status">
        此官方圖片目前無法取得（可能已被官方移除或更新中）。請至<OfficialLink agency={agency} />查看。
      </p>
    );
  }
  return <img className="tc-official-image" src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function JtwcImage({ state, fetchedAt, ended }) {
  if (state.status === "loading") return <p className="status-message">讀取中…</p>;
  if (state.status === "missing") {
    return <p className="status-message">JTWC 目前沒有這個系統的資料，因此沒有警報圖。</p>;
  }
  if (state.status !== "ok") {
    return <p className="tc-unavailable" role="note">JTWC 的資料暫時無法取得，無法顯示警報圖。</p>;
  }
  const block = state.block;
  const src = jtwcGraphic(block);
  if (!src) {
    return (
      <p className="status-message">
        這一報的資料沒有 JTWC 警報圖的連結。請至<OfficialLink agency="jtwc" />查看。
      </p>
    );
  }
  const bulletin = typeof block.bulletin === "string" && block.bulletin.trim() ? block.bulletin.trim() : null;
  return (
    <figure className="tc-figure">
      <OfficialImage key={src} src={src} agency="jtwc"
        alt={`JTWC 熱帶氣旋警報圖${bulletin ? `（第 ${bulletin} 報）` : ""}`} />
      <figcaption>
        <dl>
          <dt>來源</dt>
          <dd>
            JTWC 熱帶氣旋警報圖（TC Warning Graphic）{bulletin ? `，第 ${bulletin} 報` : ""}
            {block.final ? <><span className="tc-visually-hidden">，</span><span className="tc-flag">最終報</span></> : null}
          </dd>
          <dt>警報發布時間</dt>
          <dd><DualTime stamp={block.issued_at} /></dd>
          <dt>圖像對應的分析時間</dt>
          <dd><DualTime stamp={block.fix.analysis_time} /></dd>
          <dt>本站抓取時間（詳細資料產生時間）</dt>
          <dd><DualTime stamp={fetchedAt} /></dd>
        </dl>
        <p className="tc-note">
          {"圖片由瀏覽器直接向 JTWC 網站載入，本站不保存圖片。JTWC 每次發報都使用同一個圖片網址，所以顯示的圖可能比上列報次新；以圖上的時間為準。"}
          {ended ? "此系統已結束，官方圖片可能已被移除。" : null}
        </p>
        <p className="tc-note">
          <a href={src} target="_blank" rel="noreferrer">在 JTWC 網站開啟原圖</a>
        </p>
      </figcaption>
    </figure>
  );
}

export default function ImageryPanel({ storm, analysis, state }) {
  const fetchedAt = analysis && analysis.fetchedAt ? analysis.fetchedAt : null;
  return (
    <section className="tc-section" aria-labelledby="tc-tab-title">
      <h3 id="tc-tab-title" className="tc-visually-hidden">圖像</h3>
      <p className="tc-note">
        {"本頁只連結各機構網站上的原圖，圖片不經本站保存或修改。來源與署名見頁尾「"}
        <a href="#tc-attribution-title">資料來源與署名</a>{"」。"}
      </p>
      <section className="tc-agency" aria-label={`${AGENCY_LABELS.jtwc} 警報圖`}>
        <h5>{AGENCY_LABELS.jtwc}</h5>
        <JtwcImage state={state} fetchedAt={fetchedAt} ended={storm.status === "ended"} />
      </section>
      <div className="tc-agency-grid">
        <section className="tc-agency" aria-label={AGENCY_LABELS.jma}>
          <h5>{AGENCY_LABELS.jma}</h5>
          <p className="status-message">
            {"氣象廳沒有可直接連結的颱風路徑圖檔（官網的路徑圖是即時繪製的）。請至"}<OfficialLink agency="jma" />{"查看。"}
          </p>
        </section>
        <section className="tc-agency" aria-label={AGENCY_LABELS.cwa}>
          <h5>{AGENCY_LABELS.cwa}</h5>
          <p className="status-message">
            本站目前沒有連結中央氣象署的颱風路徑圖。請至<OfficialLink agency="cwa" />查看。
          </p>
        </section>
      </div>
      <SiteImageLinks />
    </section>
  );
}
