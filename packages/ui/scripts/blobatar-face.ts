/**
 * Vendored from blobatar 2.7.0 (MIT), https://github.com/Alain00/blobatar
 * Commit ebb7ea4808b1263629fc8fa65e2398b9cbdb6f6b, npm's gitHead for 2.7.0.
 *
 *   superellipse  packages/blobatar/src/shape.ts
 *   faceFit       packages/blobatar/src/styles/compose.ts
 *
 * Copyright (c) 2026 Alain. Licensed under the MIT License; the full notice is in LICENSE.blobatar next to this
 * file. Changes: types narrowed to what Pip needs, upstream comments cut, `Math.pow` written as `**` and a non-null
 * assertion replaced with a default, for this repo's lint. Blobatar keeps both functions private,
 * and Pip needs them to fit eyes to its own star. Delete this file if upstream makes them public.
 */
import type { Traits } from "blobatar";

export interface Superellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  n?: number;
  rot?: number;
}

const r2 = (v: number) => {
  const s = Math.round(v * 100) / 100;
  return Object.is(s, -0) ? "0" : String(s);
};

export function superellipse({ cx, cy, rx, ry, n = 4, rot = 0 }: Superellipse): string {
  const k = Math.min(1, (8 * 2 ** (-1 / n) - 4) / 3);
  const a = rx;
  const b = ry;
  const ak = a * k;
  const bk = b * k;
  const pts: [number, number][] = [
    [a, 0],
    [a, bk],
    [ak, b],
    [0, b],
    [-ak, b],
    [-a, bk],
    [-a, 0],
    [-a, -bk],
    [-ak, -b],
    [0, -b],
    [ak, -b],
    [a, -bk],
    [a, 0],
  ];
  const t = (rot * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const at = (i: number) => {
    const [x, y] = pts[i] ?? [0, 0];
    return `${r2(cx + x * cos - y * sin)} ${r2(cy + x * sin + y * cos)}`;
  };
  let d = `M${at(0)}`;
  for (let i = 1; i < 13; i += 3) d += `C${at(i)} ${at(i + 1)} ${at(i + 2)}`;
  return `${d}Z`;
}

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface Body extends Ellipse {
  n: number;
  rot: number;
}

export interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  n: number;
  rot: number;
}

export const faceFit = (t: Traits, b: Body, face: Ellipse): Eye[] => {
  const rx = b.rx;
  const er0 = t.num("eye.rx", 0.075, 0.105) * rx;
  const ratio = t.num("eye.ratio", 1.9, 3.2);
  const scale = t.num("eye.scale", 0.78, 1.24);
  const stretch = t.num("eye.stretch", 0.85, 1.18);
  const clearance = t.num("eye.gap", 0.1, 0.24) * rx;
  const wide = er0 * Math.max(1, scale);
  const tall = er0 * ratio * Math.max(1, scale * stretch);
  const gap0 = wide + rx * 0.03 + clearance;

  const gx = t.jitter("gaze.x", 0.09) * face.rx;
  const gy = t.num("gaze.y", -0.2, 0.08) * face.ry;
  const dy = t.jitter("eye.dy", 0.04) * face.ry;
  const reach = Math.hypot(wide, tall);
  const need = Math.hypot((Math.abs(gx) + gap0 + reach) / face.rx, (Math.abs(gy) + Math.abs(dy) + reach) / face.ry);
  const fit = need > 0.9 ? 0.9 / need : 1;

  const er = er0 * fit;
  const eyeRy = er * ratio;
  const gap = gap0 * fit;
  const room = Math.max(0, Math.min(1, clearance / tall));
  const bound = Math.min(12, (Math.asin(room) * 180) / Math.PI);
  const lean = t.num("eye.lean", -1, 1) * bound;
  const lean2 = Math.max(-12, Math.min(12, lean + t.jitter("eye.lean2", 3.5)));

  const cx = face.cx + gx * fit;
  const cy = face.cy + gy * fit;
  return [
    { cx: cx - gap, cy, rx: er, ry: eyeRy, n: t.num("eye.n", 3.5, 6), rot: lean },
    {
      cx: cx + gap,
      cy: cy + dy * fit,
      rx: er * scale,
      ry: eyeRy * scale * stretch,
      n: t.num("eye.n", 3.5, 6),
      rot: lean2,
    },
  ];
};
