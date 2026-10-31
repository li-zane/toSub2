import React, { useEffect, useState } from "react";

function intervalLabel(point) {
  const format = (value) => new Date(value).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${format(point.start)} – ${format(point.end)}`;
}

export function OverloadDetection({ job, token, onError }) {
  const [busy, setBusy] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [saved, setSaved] = useState(null);
  const source = job.overloadDetection;
  useEffect(() => {
    if (saved && source?.enabled === saved.enabled) setSaved(null);
  }, [source?.enabled, saved]);
  // A completed save remains authoritative until the regular job poll catches up.
  const detection = saved && source?.enabled !== saved.enabled ? saved : source || saved;
  const enabled = detection?.enabled === true;
  const points = detection?.points || [];
  const max = Math.max(1, ...points.map((point) => point.count ?? 0));
  const positioned = points.map((point, index) => ({
    ...point, x: 18 + index * 26, y: 44 - ((point.count ?? 0) / max) * 34,
  }));
  const segments = [];
  let segment = [];
  for (const point of positioned) {
    if (point.count === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push(`${point.x},${point.y}`);
  }
  if (segment.length) segments.push(segment);
  const active = hovered === null ? null : positioned[hovered];

  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/overload-detection`, {
        method: "POST", headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "过载检测开关保存失败");
      setSaved(data.job.overloadDetection);
      onError("");
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="overload-detection">
      <button
        type="button" role="switch" aria-checked={enabled}
        aria-label={`${job.email} 过载检测`} aria-busy={busy}
        title={detection?.configured ? (enabled ? "停止过载检测" : "开启过载检测") : "请先配置 Sub2API 后端"}
        className={`overload-switch ${enabled ? "enabled" : "disabled"}`}
        disabled={busy || !token || (!detection?.configured && !enabled)} onClick={toggle}
      ><span aria-hidden="true" /></button>
      <div className="overload-chart">
        <svg viewBox="0 0 164 56" role="group" aria-label="过去六个完整小时的 503 过载报错数量">
          <line className="overload-zero" x1="14" x2="156" y1="44" y2="44" />
          <text className="overload-zero-label" x="1" y="48">0</text>
          {segments.map((values, index) => <polyline key={index} className="overload-line" points={values.join(" ")} />)}
          {positioned.map((point, index) => (
            <g key={point.start} className="overload-point" tabIndex="0" role="img"
              aria-label={`${intervalLabel(point)}：${point.count === null ? "未统计" : `${point.count} 次`}`}
              onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)} onBlur={() => setHovered(null)}
              onClick={() => setHovered(index)} onKeyDown={(event) => { if (event.key === "Escape") setHovered(null); }}>
              <rect className="overload-hit-area" x={point.x - 13} y="0" width="26" height="56" />
              {point.count !== null && <circle className={`overload-dot ${hovered === index ? "active" : ""}`} cx={point.x} cy={point.y} r={hovered === index ? 3.5 : 2.5} />}
            </g>
          ))}
        </svg>
        {active && <div className={`overload-tooltip point-${hovered}`} role="tooltip">
          <span>{intervalLabel(active)}</span>
          <strong>{active.count === null ? "未统计" : `${active.count} 次`}</strong>
        </div>}
        {detection?.lastError && <span className="overload-error" role="img" aria-label={detection.lastError} title={detection.lastError}>!</span>}
      </div>
    </div>
  );
}
