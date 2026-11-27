import { useState } from "react";

export default function SourceImage({ image, alt = image.title, className = "detail-image cwa-detail-image" }) {
  // The failure belongs to one URL and is cleared during render when the URL changes, so each newly
  // shown image is tried again. Clearing it in an effect instead raced with early error events: a
  // mount effect that ran after the error wiped the failure (seen under React 19 in publishing tests).
  const [state, setState] = useState({ url: image.image_url, failed: false });
  if (state.url !== image.image_url) setState({ url: image.image_url, failed: false });
  const failed = state.failed;
  return <>
    {!failed ? <img className={className} src={image.image_url} alt={alt}
      onError={() => setState({ url: image.image_url, failed: true })} /> : null}
    {failed ? <p className="status-message" role="status">
      此時次的官方圖片目前無法取得。<a href={image.source_url} target="_blank" rel="noreferrer">查看官方來源</a>
    </p> : null}
  </>;
}
