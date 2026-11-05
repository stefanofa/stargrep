// Writes the favicons and the web manifest into public/ from Pip's star: bun run favicon
import { Resvg } from "@resvg/resvg-js";

// Pip's star, and the eyes Pip draws at small sizes, so the tab icon matches the header mark.
const starPoints =
  "50,16 61.17,38.63 86.14,42.26 68.07,59.87 72.34,84.74 50,73 27.66,84.74 31.93,59.87 13.86,42.26 38.83,38.63";
const starStroke = { edge: 12, fill: 10 };
const eyes = [
  "M42.52 52.39C42.14 59.8 42.14 59.8 39.4 59.66C36.67 59.53 36.67 59.53 37.04 52.11C37.41 44.7 37.41 44.7 40.15 44.84C42.89 44.98 42.89 44.98 42.52 52.39Z",
  "M62.74 52.38C62.39 59.29 62.39 59.29 59.87 59.16C57.36 59.03 57.36 59.03 57.71 52.13C58.06 45.22 58.06 45.22 60.57 45.35C63.08 45.47 63.08 45.47 62.74 52.38Z",
];

const colors = { highlight: "#ffd84d", edge: "#e9b826", ink: "#1e1b2e", background: "#f5f2ff" };

// A round join reaches half the stroke past each vertex, so the star's box is the points' box grown by that much.
const coords = starPoints.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);
const reach = starStroke.edge / 2;
const [minX, maxX] = [Math.min(...coords.map(([x]) => x)) - reach, Math.max(...coords.map(([x]) => x)) + reach];
const [minY, maxY] = [Math.min(...coords.map(([, y]) => y)) - reach, Math.max(...coords.map(([, y]) => y)) + reach];
const side = Math.max(maxX - minX, maxY - minY);

interface Mark {
  readonly face: boolean;
  // A plate fills the square behind the star, for icons a launcher crops or puts on black. The star then takes
  // `scale` of the side, inside the circle Android keeps when it masks an icon.
  readonly plate?: { readonly color: string; readonly scale: number };
}

const svg = ({ face, plate }: Mark) => {
  const box = plate ? side / plate.scale : side;
  const [x, y] = [(minX + maxX - box) / 2, (minY + maxY - box) / 2];
  const view = [x, y, box, box].map((value) => +value.toFixed(2)).join(" ");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}">`,
    plate ? `<rect x="${x}" y="${y}" width="${box}" height="${box}" fill="${plate.color}"/>` : "",
    `<polygon points="${starPoints}" fill="${colors.edge}" stroke="${colors.edge}" stroke-width="${starStroke.edge}" stroke-linejoin="round"/>`,
    `<polygon points="${starPoints}" fill="${colors.highlight}" stroke="${colors.highlight}" stroke-width="${starStroke.fill}" stroke-linejoin="round"/>`,
    face ? eyes.map((d) => `<path d="${d}" fill="${colors.ink}"/>`).join("") : "",
    "</svg>",
  ].join("");
};

const png = (mark: Mark, size: number) =>
  new Resvg(svg(mark), { fitTo: { mode: "width", value: size }, shapeRendering: 2 }).render().asPng();

// An ICO is a directory of images. Each entry here holds a PNG, which every browser that still reads ICO accepts.
const ico = (images: ReadonlyArray<{ readonly size: number; readonly data: Uint8Array }>) => {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
};

const tile = { face: true, plate: { color: colors.background, scale: 0.68 } } satisfies Mark;

const manifest = {
  name: "Stargrep",
  short_name: "Stargrep",
  description: "Search your GitHub stars in plain words.",
  start_url: "/",
  background_color: colors.background,
  theme_color: colors.background,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const outputs: Record<string, string | Uint8Array> = {
  "favicon.svg": svg({ face: true }),
  // At 16 device pixels each eye is one pixel wide and blurs to brown, so that frame drops the face. The SVG keeps it,
  // because an SVG image cannot tell a 1x screen from a 2x one, and at 2x the eyes stay sharp.
  "favicon.ico": ico([
    { size: 16, data: png({ face: false }, 16) },
    { size: 32, data: png({ face: true }, 32) },
  ]),
  "apple-touch-icon.png": png(tile, 180),
  "icon-192.png": png(tile, 192),
  "icon-512.png": png(tile, 512),
  "manifest.webmanifest": `${JSON.stringify(manifest, null, 2)}\n`,
};

for (const [file, data] of Object.entries(outputs))
  await Bun.write(new URL(`../public/${file}`, import.meta.url), data);
