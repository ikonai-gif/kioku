/**
 * Snapshot loader + cosine similarity for KHMB.
 *
 * Reads the local production snapshot (CSV) and the matching vectors file.
 * These files live OUTSIDE the repo (under the bench data dir passed in) and
 * are never committed — they contain real user-10 memory content.
 *
 * The CSV parser is a small dependency-free RFC-4180 reader: it handles
 * quoted fields, embedded commas, embedded newlines, and "" escapes, which
 * the memory `content` column needs (multi-line text with commas/quotes).
 */
import { readFileSync } from "fs";
import type { MemoryRow, VectorMap } from "./types";

/** Minimal RFC-4180 CSV parse into array-of-records keyed by header row. */
export function parseCsv(raw: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      record.push(field); field = "";
    } else if (ch === "\n") {
      record.push(field); field = "";
      rows.push(record); record = [];
    } else if (ch === "\r") {
      // ignore; handled by \n
    } else field += ch;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }

  if (rows.length === 0) return [];
  const header = rows[0];
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) rec[header[c]] = rows[r][c] ?? "";
    out.push(rec);
  }
  return out;
}

export function loadSnapshot(csvPath: string): MemoryRow[] {
  const records = parseCsv(readFileSync(csvPath, "utf-8"));
  return records.map((r) => ({
    id: Number(r.id),
    content: r.content ?? "",
    type: r.type ?? "",
    namespace: r.namespace ?? "",
    importance: num(r.importance, 0.5),
    confidence: num(r.confidence, 1.0),
    strength: num(r.strength, 1.0),
    decayRate: num(r.decay_rate, 0.01),
    provenance: r.provenance ?? "luca_inferred",
    verified: r.verified === "t" || r.verified === "true",
    createdAt: num(r.created_at, 0),
    lastAccessedAt: num(r.last_accessed_at, 0),
    accessCount: num(r.access_count, 0),
  })).filter((r) => Number.isFinite(r.id));
}

export function loadVectors(csvPath: string): VectorMap {
  const raw = readFileSync(csvPath, "utf-8");
  const map: VectorMap = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const id = Number(line.slice(0, comma));
    if (!Number.isFinite(id)) continue;
    let vecText = line.slice(comma + 1).trim();
    if (vecText.startsWith('"')) vecText = vecText.slice(1, -1);
    vecText = vecText.replace(/^\[/, "").replace(/\]$/, "");
    const parts = vecText.split(",");
    const vec = new Float64Array(parts.length);
    for (let i = 0; i < parts.length; i++) vec[i] = parseFloat(parts[i]);
    map.set(id, vec);
  }
  return map;
}

/** Cosine similarity between two equal-length vectors. */
export function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
