import type { Rgb } from "./pixels.js";

/**
 * Text and app UI laid over a photo. Boxes are fractions of the image (x0, y0, x1, y1).
 * `fill` is the main colour of the text's letters; the outline or shadow around them is picked up by growing the letters.
 */
export type Overlay = { type: "text"; box: [number, number, number, number]; fill: string } | { type: "ui"; box: [number, number, number, number] };

const hex = (value: string): [number, number, number] => {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid colour ${value}`);
  const n = parseInt(match[1]!, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

function pixelBox(box: [number, number, number, number], width: number, height: number, pad = 0): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  return [
    Math.max(0, Math.floor(Math.min(x0, x1) * width) - pad), Math.max(0, Math.floor(Math.min(y0, y1) * height) - pad),
    Math.min(width, Math.ceil(Math.max(x0, x1) * width) + pad), Math.min(height, Math.ceil(Math.max(y0, y1) * height) + pad),
  ];
}

/** Which source pixels to keep: whole UI boxes, and inside text boxes the letters (near the fill colour) grown by their outline width. */
export function overlayMask(source: Rgb, overlays: Overlay[]): Uint8Array {
  const { width, height, data } = source;
  const mask = new Uint8Array(width * height);
  // Outline and shadow width scales with the image; about 0.6% of the shorter side.
  const grow = Math.max(3, Math.round(Math.min(width, height) * 0.006));
  for (const overlay of overlays) {
    if (overlay.type === "ui") {
      const [x0, y0, x1, y1] = pixelBox(overlay.box, width, height);
      for (let y = y0; y < y1; y += 1) mask.fill(1, y * width + x0, y * width + x1);
      continue;
    }
    const [r, g, b] = hex(overlay.fill);
    const [x0, y0, x1, y1] = pixelBox(overlay.box, width, height, grow);
    const letters = new Uint8Array(width * height);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 3;
        const distance = Math.abs(data[i]! - r) + Math.abs(data[i + 1]! - g) + Math.abs(data[i + 2]! - b);
        if (distance < 90) letters[y * width + x] = 1;
      }
    }
    // Grow the letters by `grow` pixels (a square dilation, done as two passes), staying inside the padded box.
    const rows = new Uint8Array(width * height);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        for (let dx = -grow; dx <= grow; dx += 1) {
          const xx = x + dx;
          if (xx >= x0 && xx < x1 && letters[y * width + xx]) { rows[y * width + x] = 1; break; }
        }
      }
    }
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        for (let dy = -grow; dy <= grow; dy += 1) {
          const yy = y + dy;
          if (yy >= y0 && yy < y1 && rows[yy * width + x]) { mask[y * width + x] = 1; break; }
        }
      }
    }
  }
  return mask;
}

/** The new photo with the source's text and UI pixels copied back exactly. */
export function compositeOverlays(base: Rgb, source: Rgb, mask: Uint8Array): Rgb {
  if (base.width !== source.width || base.height !== source.height) throw new Error("The new photo must have the source's size");
  const data = Buffer.from(base.data);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 3;
    data[i] = source.data[i]!; data[i + 1] = source.data[i + 1]!; data[i + 2] = source.data[i + 2]!;
  }
  return { width: base.width, height: base.height, data };
}
