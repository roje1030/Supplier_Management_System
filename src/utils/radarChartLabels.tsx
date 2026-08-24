import type { CSSProperties } from 'react';
import type { Props as RechartsLabelProps } from 'recharts/types/component/Label';

const RADIAN = Math.PI / 180;

interface RadarLabelOptions {
  /** Number of vertices around the radar (categories). Recharts spaces them
   *  evenly starting at 90deg (top) and sweeping clockwise - every RadarChart
   *  in this app uses that default, so the angle of vertex `index` can be
   *  derived from it without needing Recharts to hand us cx/cy/angle (which
   *  its LabelList/label plumbing doesn't expose). */
  categoryCount: number;
  fill: string;
  fontSize?: number;
  fontWeight?: CSSProperties['fontWeight'];
  formatter?: (value: number) => string;
  /** Px pulled back from the vertex toward the chart center. Recharts'
   *  built-in "top"/"bottom" label position instead pushes the label further
   *  out past the vertex, which is exactly where the category name printed
   *  by PolarAngleAxis sits on that same ray - hence the collisions. Pulling
   *  inward keeps the label clear of that text on every vertex, not just
   *  top/bottom ones, without touching outerRadius or chart size. */
  radialInset?: number;
  /** Px nudge perpendicular to the vertex ray (i.e. sideways, tangent to the
   *  radar), so two series sharing a vertex (e.g. company vs. peer average)
   *  don't land on top of each other. Give each series an opposite sign. */
  lane?: number;
}

/**
 * Builds a label renderer usable as `<LabelList content={...} />` or
 * `<Radar label={...} />`. Places each score near its vertex, offset inward
 * toward the chart center and sideways along the tangent, so it never
 * collides with the category label sitting just outside that same vertex.
 */
export function radarPointLabel({
  categoryCount,
  fill,
  fontSize = 11,
  fontWeight = 'bold',
  formatter = (value) => value.toFixed(1),
  radialInset = 14,
  lane = 0,
}: RadarLabelOptions) {
  return function RadarPointLabel({ viewBox, value, index }: RechartsLabelProps) {
    const x =
      viewBox && 'x' in viewBox && typeof viewBox.x === 'number'
        ? viewBox.x
        : viewBox && 'cx' in viewBox && typeof viewBox.cx === 'number'
          ? viewBox.cx
          : undefined;
    const y =
      viewBox && 'y' in viewBox && typeof viewBox.y === 'number'
        ? viewBox.y
        : viewBox && 'cy' in viewBox && typeof viewBox.cy === 'number'
          ? viewBox.cy
          : undefined;
    const numeric = typeof value === 'number' ? value : parseFloat(String(value));
    if (x == null || y == null || index == null || Number.isNaN(numeric) || categoryCount <= 0) {
      return null;
    }

    const angle = 90 - (360 / categoryCount) * index;
    const rad = angle * RADIAN;
    const outX = Math.cos(rad);
    const outY = -Math.sin(rad);
    // Tangent is the outward vector rotated 90deg - used to separate labels
    // sideways instead of pushing them further from (or back into) the vertex.
    const tangentX = -outY;
    const tangentY = outX;

    const lx = x - outX * radialInset + tangentX * lane;
    const ly = y - outY * radialInset + tangentY * lane;
    // Anchor text so it grows inward (away from the vertex/axis label),
    // rather than back out toward whichever side it was pulled in from.
    const textAnchor = outX > 0.35 ? 'end' : outX < -0.35 ? 'start' : 'middle';

    return (
      <text
        x={lx}
        y={ly}
        textAnchor={textAnchor}
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight={fontWeight}
        fill={fill}
      >
        {formatter(numeric)}
      </text>
    );
  };
}
