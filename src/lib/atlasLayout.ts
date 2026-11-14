export type ChartBox = {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
};

export type GalleryTransform = {
  left: number;
  top: number;
  scale: number;
  minU: number;
  maxV: number;
};

export type GalleryLayout = {
  columns: number;
  rows: number;
  side: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  scale: number;
  transforms: GalleryTransform[];
};

export type GalleryOptions = {
  side?: number;
  top?: number;
  bottom?: number;
  gapRatio?: number;
};

/** Lays individual chart bounds into a grid. A single shared scale keeps the
 * relative size of each chart, so density differences stay readable. */
export function layoutGallery(
  boxes: ChartBox[],
  width: number,
  height: number,
  options: GalleryOptions = {},
): GalleryLayout {
  const count = boxes.length;
  const side = options.side ?? Math.min(16, Math.max(1, width) * 0.05);
  const top = options.top ?? 28;
  const bottom = options.bottom ?? 22;
  if (count === 0) {
    return {
      columns: 0,
      rows: 0,
      side,
      top,
      cellWidth: 0,
      cellHeight: 0,
      scale: 0,
      transforms: [],
    };
  }

  const columns = Math.max(
    1,
    Math.min(
      count,
      Math.round(Math.sqrt((count * Math.max(1, width)) / Math.max(1, height))),
    ),
  );
  const rows = Math.ceil(count / columns);
  const cellWidth = Math.max(1, (Math.max(1, width) - side * 2) / columns);
  const cellHeight = Math.max(1, (Math.max(1, height) - top - bottom) / rows);
  const gap = Math.max(
    2,
    Math.min(10, Math.min(cellWidth, cellHeight) * (options.gapRatio ?? 0.08)),
  );
  const widths = boxes.map((box) => Math.max(1e-9, box.maxU - box.minU));
  const heights = boxes.map((box) => Math.max(1e-9, box.maxV - box.minV));
  const maxWidth = widths.reduce((max, value) => Math.max(max, value), 1e-9);
  const maxHeight = heights.reduce((max, value) => Math.max(max, value), 1e-9);
  const scale = Math.min(
    Math.max(1e-9, cellWidth - gap * 2) / maxWidth,
    Math.max(1e-9, cellHeight - gap * 2) / maxHeight,
  );

  const transforms = boxes.map((box, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const cellLeft = side + column * cellWidth;
    const cellTop = top + row * cellHeight;
    const chartWidth = widths[index];
    const chartHeight = heights[index];
    return {
      left: cellLeft + (cellWidth - chartWidth * scale) / 2 - box.minU * scale,
      top: cellTop + (cellHeight - chartHeight * scale) / 2,
      scale,
      minU: box.minU,
      maxV: box.maxV,
    };
  });

  return { columns, rows, side, top, cellWidth, cellHeight, scale, transforms };
}
