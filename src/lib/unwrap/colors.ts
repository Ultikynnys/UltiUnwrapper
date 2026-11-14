export type RGB = [number, number, number];

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

/** Stable chart color from a golden-angle hue walk. */
export function chartColor(chart: number): RGB {
  return hslToRgb(chart * 137.508, 0.62, 0.55);
}

export function chartColorCss(chart: number): string {
  const [r, g, b] = chartColor(chart);
  return `rgb(${r} ${g} ${b})`;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const amount = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount),
  ];
}

const HEAT_STOPS: RGB[] = [
  [38, 93, 171],
  [65, 182, 196],
  [255, 230, 85],
  [215, 48, 39],
];

/** Blue -> cyan -> yellow -> red, clamped to [0, max]. */
export function heatColor(value: number, max: number): RGB {
  const scaled = Math.min(Math.max(value, 0), Math.max(max, 1e-9)) / Math.max(max, 1e-9);
  const position = scaled * (HEAT_STOPS.length - 1);
  const index = Math.min(Math.floor(position), HEAT_STOPS.length - 2);
  return mix(HEAT_STOPS[index], HEAT_STOPS[index + 1], position - index);
}

/** Green at ratio 1, red below, blue above. Mirrors UltiPixelizer's texel
 * variance ramp so density weaknesses read the same way in both tools. */
export function densityColor(ratio: number): RGB {
  const green: RGB = [76, 200, 120];
  const red: RGB = [225, 80, 72];
  const blue: RGB = [72, 120, 220];
  if (ratio <= 1) return mix(red, green, Math.min(1, Math.max(0, (ratio - 0.5) / 0.5)));
  return mix(green, blue, Math.min(1, Math.max(0, (ratio - 1) / 0.5)));
}

export function rgbCss([r, g, b]: RGB): string {
  return `rgb(${r} ${g} ${b})`;
}
