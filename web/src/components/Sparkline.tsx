/**
 * A price sparkline that shades the period since the user last checked.
 *
 * The shading is the entire reason this is hand-rolled rather than pulled from
 * a chart library. A generic sparkline shows "the price went here"; this one
 * shows "the price went *here since you last looked*", which is the question
 * the product exists to answer. Everything else - axes, tooltips, legends - is
 * omitted on purpose at this size, where it would be noise.
 */

import { useMemo } from 'react';
import type { Bar } from '../lib/types.js';

interface Props {
  bars: readonly Bar[];
  /** Current live price, appended so the line reaches "now". */
  livePrice?: number | null;
  /** Timestamp of the user's watermark; the region after it is shaded. */
  sinceTs?: number | null;
  width?: number;
  height?: number;
  /** Show the shaded since-you-looked band. */
  showSince?: boolean;
}

interface Point {
  x: number;
  y: number;
  ts: number;
  value: number;
}

export function Sparkline({
  bars,
  livePrice,
  sinceTs,
  width = 200,
  height = 44,
  showSince = true,
}: Props): React.JSX.Element | null {
  const model = useMemo(() => {
    const series: Array<{ ts: number; value: number }> = bars.map((b) => ({
      ts: b.ts,
      value: b.close,
    }));

    if (livePrice !== null && livePrice !== undefined && Number.isFinite(livePrice)) {
      const lastTs = series.length > 0 ? (series[series.length - 1] as { ts: number }).ts : Date.now();
      series.push({ ts: lastTs + 1, value: livePrice });
    }

    if (series.length < 2) return null;

    const values = series.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);

    // A perfectly flat series would divide by zero and collapse to a line at
    // the top of the box; pad it so it renders as a flat line in the middle.
    if (max - min < 1e-9) {
      const pad = Math.max(Math.abs(max) * 0.01, 0.01);
      min -= pad;
      max += pad;
    }

    const padY = 3;
    const usableH = height - padY * 2;
    const n = series.length;

    const points: Point[] = series.map((p, i) => ({
      x: (i / (n - 1)) * width,
      y: padY + (1 - (p.value - min) / (max - min)) * usableH,
      ts: p.ts,
      value: p.value,
    }));

    const path = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ');

    const area = `${path} L${width},${height} L0,${height} Z`;

    // Where does the "since you looked" region begin?
    let sinceX: number | null = null;
    if (showSince && sinceTs !== null && sinceTs !== undefined) {
      const idx = series.findIndex((p) => p.ts >= sinceTs);
      if (idx > 0) sinceX = (idx / (n - 1)) * width;
      else if (idx === 0) sinceX = 0;
    }

    const first = points[0] as Point;
    const last = points[points.length - 1] as Point;

    // Colour by the move over the *shaded* window when there is one, because
    // that is the change the user is being asked to judge.
    const refIndex =
      sinceX === null ? 0 : Math.max(0, series.findIndex((p) => p.ts >= (sinceTs as number)));
    const ref = (points[refIndex] ?? first) as Point;
    const trend = last.value > ref.value ? 'up' : last.value < ref.value ? 'down' : 'flat';

    return { path, area, sinceX, trend, last, min, max };
  }, [bars, livePrice, sinceTs, width, height, showSince]);

  if (!model) {
    return (
      <svg className="spark" width={width} height={height} aria-hidden="true">
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--hairline-strong)"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const stroke =
    model.trend === 'up' ? 'var(--up)' : model.trend === 'down' ? 'var(--down)' : 'var(--text-3)';

  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Price history sparkline${model.sinceX !== null ? ', with the period since you last checked highlighted' : ''}`}
    >
      {model.sinceX !== null && model.sinceX < width - 1 ? (
        <>
          <rect
            className="since-band"
            x={model.sinceX}
            y={0}
            width={width - model.sinceX}
            height={height}
            rx={2}
          />
          <line className="mark-line" x1={model.sinceX} y1={0} x2={model.sinceX} y2={height} />
        </>
      ) : null}

      <path className="area" d={model.area} fill={stroke} />
      <path className={`line ${model.trend}`} d={model.path} stroke={stroke} />
      <circle cx={model.last.x} cy={model.last.y} r={2.4} fill={stroke} />
    </svg>
  );
}
