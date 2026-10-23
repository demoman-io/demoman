import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One rendered candidate, as `share-measure.ts` measured it. */
export interface Candidate {
  kind: "file";
  /** The file's name inside the output folder. */
  file: string;
  frame: string;
  width: number;
  height: number;
  fps: number;
  encoder: string;
  /** What the sink reported it was built with, and whether that is what was
   *  asked for. */
  encoderUsed: { text: string; ok: boolean };
  /** What the encoder was opened with (`EncoderUsed.rateControl`):
   *  "quantizer", or "bitrate <n>" where quantizer mode was refused. */
  rateControl: string;
  /** What the target asked for, in Mbps; null when the encoder was steered
   *  by quality instead. */
  askedMbps: number | null;
  bytes: number;
  /** ffprobe's `format.bit_rate`, in Mbps: what the file really holds. */
  realMbps: number;
  durationSec: number;
  /** Crop file names, or why there is none. */
  still: Crop;
  zoom: Crop;
}

export type Crop =
  | { kind: "png"; file: string; width: number; height: number }
  | { kind: "none"; why: string };

/** A combination the browser refused or could not measure, with its error. */
export interface Refused {
  kind: "refused";
  label: string;
  error: string;
}

export interface TakeRow {
  takeId: string;
  name: string;
  /** What the crops are cut from, in words (the rectangle and the times). */
  cropNote: string;
  candidates: (Candidate | Refused)[];
}

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(2)} MB`;

function cropHtml(label: string, crop: Crop): string {
  if (crop.kind === "none") {
    return `<figure class="crop none"><figcaption>${esc(label)}</figcaption><p>${esc(crop.why)}</p></figure>`;
  }
  // 1:1 pixels: width and height attributes name the file's own size.
  return `<figure class="crop"><figcaption>${esc(label)} (${crop.width}×${crop.height}, 1:1)</figcaption><img src="${esc(crop.file)}" width="${crop.width}" height="${crop.height}" alt="${esc(label)}"></figure>`;
}

function cardHtml(c: Candidate | Refused): string {
  if (c.kind === "refused") {
    return `<article class="card refused"><h3>${esc(c.label)}</h3><p class="why">Refused: ${esc(c.error)}</p></article>`;
  }
  const asked =
    c.askedMbps === null ? "quality-driven" : `asked ${c.askedMbps.toFixed(1)}`;
  return `<article class="card">
<video controls loop muted preload="metadata" src="${esc(c.file)}"></video>
<div class="crops">${cropHtml("still", c.still)}${cropHtml("mid-zoom", c.zoom)}</div>
<dl>
<div><dt>size</dt><dd>${mb(c.bytes)}</dd></div>
<div><dt>real</dt><dd>${c.realMbps.toFixed(2)} Mbps (${asked})</dd></div>
<div><dt>frame</dt><dd>${esc(c.frame)} ${c.width}×${c.height}</dd></div>
<div><dt>fps</dt><dd>${c.fps}</dd></div>
<div><dt>encoder</dt><dd>${esc(c.encoder)}</dd></div>
<div class="used${c.encoderUsed.ok ? "" : " bad"}"><dt>sink used</dt><dd>${esc(c.encoderUsed.text)}</dd></div>
<div class="used${c.rateControl.startsWith("NOT") ? " bad" : ""}"><dt>rate control</dt><dd>${esc(c.rateControl)}</dd></div>
<div><dt>length</dt><dd>${c.durationSec.toFixed(1)} s</dd></div>
</dl></article>`;
}

/** Candidates smallest first; a refused one goes last, where it is read. */
export function sortedBySize(
  list: readonly (Candidate | Refused)[],
): (Candidate | Refused)[] {
  const files = list.filter((c): c is Candidate => c.kind === "file");
  const refused = list.filter((c): c is Refused => c.kind === "refused");
  return [...files.sort((a, b) => a.bytes - b.bytes), ...refused];
}

export function pageHtml(rows: readonly TakeRow[]): string {
  const sections = rows
    .map(
      (row) => `<section>
<h2>${esc(row.name)} <small>${esc(row.takeId)}</small></h2>
<p class="note">${esc(row.cropNote)}</p>
<div class="grid">${sortedBySize(row.candidates).map(cardHtml).join("\n")}</div>
</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share-size candidates</title>
<style>
:root { color-scheme: light dark;
  --shell: #eef0f4; --card: #ffffff; --ink: #111827; --ink-muted: #4b5563;
  --ring: rgba(17,24,39,.1); --control: #e4e7ed; --error: #991b1b;
  --error-soft: #fef2f2; --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --shell: #010102; --card: #181818; --ink: #ececf1; --ink-muted: #b4b4bd;
  --ring: rgba(255,255,255,.1); --control: rgba(255,255,255,.07);
  --error: #fca5a5; --error-soft: #3b1a1a; } }
body { margin: 0; padding: 24px 16px; background: var(--shell); color: var(--ink);
  font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 32px 0 4px; } h2 small { color: var(--ink-muted); font: 12px var(--font-mono); }
.note { color: var(--ink-muted); margin: 0 0 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 12px; }
.card { background: var(--card); border-radius: 8px; box-shadow: 0 0 0 1px var(--ring); padding: 12px; min-width: 0; }
.card video { width: 100%; background: #000; border-radius: 6px; }
.crops { display: grid; gap: 8px; margin: 8px 0; }
.crop { margin: 0; min-width: 0; overflow-x: auto; }
.crop figcaption { color: var(--ink-muted); font-size: 12px; }
.crop img { display: block; max-width: none; }
.crop.none { background: var(--error-soft); color: var(--error); padding: 6px 8px; border-radius: 6px; }
.crop.none p { margin: 0; }
dl { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 12px; margin: 0; font-family: var(--font-mono); font-size: 12px; }
dl div { display: flex; gap: 6px; } dt { color: var(--ink-muted); } dd { margin: 0; }
.card.refused { background: var(--error-soft); color: var(--error); } .card.refused h3 { margin: 0 0 4px; font-size: 13px; }
.used { grid-column: 1 / -1; } .used.bad { color: var(--error); background: var(--error-soft); padding: 2px 6px; border-radius: 4px; } .used dd { overflow-wrap: anywhere; }
.why { margin: 0; font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
</style></head><body>
<h1>Share-size candidates</h1>
${sections}
</body></html>
`;
}

export async function writePage(
  outDir: string,
  rows: readonly TakeRow[],
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "index.html");
  await writeFile(path, pageHtml(rows));
  return path;
}
