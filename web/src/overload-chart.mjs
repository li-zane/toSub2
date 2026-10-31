export function buildOverloadChart(points = []) {
  const valid = (value) => Number.isFinite(value) && value >= 0;
  const maximum = (field) => Math.max(1, ...points.map((point) => valid(point[field]) ? point[field] : 0));
  const overloadMax = maximum("count");
  const requestMax = maximum("requestCount");
  const positioned = points.map((point, index) => ({ ...point, x: 18 + index * 26,
    y: valid(point.count) ? 44 - (point.count / overloadMax) * 34 : null,
    requestY: valid(point.requestCount) ? 44 - (point.requestCount / requestMax) * 34 : null,
  }));
  function segments(field) {
    const output = [];
    let segment = [];
    for (const point of positioned) {
      if (point[field] === null) {
        if (segment.length) output.push(segment.join(" "));
        segment = [];
      } else segment.push(`${point.x},${point[field]}`);
    }
    if (segment.length) output.push(segment.join(" "));
    return output;
  }
  return { positioned, overloadSegments: segments("y"), requestSegments: segments("requestY") };
}
