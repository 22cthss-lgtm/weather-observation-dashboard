// Imagery tab and site links (design.md 7.6, 11i). Only official image addresses are linked; the
// site never stores image bodies. Nothing here reads the clock.

/**
 * The only image the contract carries: the JTWC warning graphic (analysis.json `graphic_url`,
 * design.md 1.4). Same rule as the backend validator (fetchers/src/tropical_contract.py GRAPHIC_URL),
 * so an unexpected address is never put into an <img>.
 */
export const JTWC_GRAPHIC_PATTERN = /^https:\/\/www\.metoc\.navy\.mil\/jtwc\/products\/[A-Za-z0-9_.-]{1,80}\.gif$/;

/** @returns the JTWC graphic address of an analysis block, or null when there is none or it is unexpected. */
export function jtwcGraphic(block) {
  const url = block && typeof block === "object" ? block.graphic_url : null;
  return typeof url === "string" && JTWC_GRAPHIC_PATTERN.test(url) ? url : null;
}

/** Official pages for each agency (checked by hand on 2026-11-23, design.md 11i). */
export const OFFICIAL_PAGES = {
  jtwc: { href: "https://www.metoc.navy.mil/jtwc/jtwc.html", label: "JTWC 網站" },
  jma: { href: "https://www.jma.go.jp/bosai/map.html#contents=typhoon", label: "気象庁ホームページ「台風情報」" },
  cwa: { href: "https://www.cwa.gov.tw/V8/C/P/Typhoon/TY_NEWS.html", label: "中央氣象署「颱風消息」" },
};

/** Existing image pages of this site (routes unchanged, App.jsx). */
export const SITE_IMAGE_LINKS = [
  { to: "/images/satellite", label: "Satellite", description: "衛星雲圖" },
  { to: "/images/cimss_wind_analysis", label: "CIMSS / Wind Analysis", description: "垂直風切與 850 hPa 渦度" },
  { to: "/images/cimss_steering_flow", label: "CIMSS / Steering Flow", description: "駛流場" },
  { to: "/images/tchp", label: "CWA TCHP", description: "颱風熱含量" },
  { to: "/images/sst", label: "JMA SST", description: "海面水溫" },
];
