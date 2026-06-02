/**
 * [LUCA-060] MarkItDown extraction — subprocess v1 (BRO1-approved).
 *
 * Shells out to Python's `markitdown` to convert rich documents (docx, xlsx,
 * pptx, html, epub, …) to Markdown text. Used by attachment-summarizer for the
 * formats that pdf-parse / utf8 can't handle.
 *
 * Pure best-effort: ANY failure (binary missing, timeout, oversize, unsupported
 * type, non-zero exit) returns null and the caller falls back to its existing
 * behavior. This is therefore safe to ship even before the Docker image has
 * python/markitdown installed — it simply no-ops until the runtime has it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import logger from "../logger";

const execFileAsync = promisify(execFile);

const MAX_BYTES = 15 * 1024 * 1024; // skip files larger than 15 MB
const TIMEOUT_MS = 45_000; // hard cap on the subprocess
const MAX_OUTPUT = 200_000; // cap returned text length (matches utf8 path)

// Extensions MarkItDown handles well that our other paths don't.
const ALLOWED_EXT = new Set([
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  ".html", ".htm", ".epub", ".rtf", ".odt",
]);

const MIME_TO_EXT: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-powerpoint": ".ppt",
  "text/html": ".html",
  "application/epub+zip": ".epub",
  "application/rtf": ".rtf",
  "application/vnd.oasis.opendocument.text": ".odt",
};

function extFromName(originalName: string): string | null {
  const m = originalName.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m && ALLOWED_EXT.has(m[1]) ? m[1] : null;
}

/** A usable extension for the temp file (MarkItDown infers type from it). */
function pickExtension(originalName: string, mime: string): string | null {
  return extFromName(originalName) ?? MIME_TO_EXT[mime] ?? null;
}

/** True if MarkItDown is worth trying for this attachment. */
export function isMarkItDownCandidate(originalName: string, mime: string): boolean {
  return extFromName(originalName) !== null || mime in MIME_TO_EXT;
}

/** Injectable runner so the spawn/parse logic is testable without a real CLI. */
export type MarkItDownRunner = (filePath: string) => Promise<string>;

const defaultRunner: MarkItDownRunner = async (filePath) => {
  // `python3 -m markitdown <file>` prints Markdown to stdout.
  const { stdout } = await execFileAsync("python3", ["-m", "markitdown", filePath], {
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout || "";
};

/**
 * Extract Markdown text from a document via MarkItDown.
 * Returns trimmed text (capped), or null on any failure / non-candidate / oversize.
 */
export async function extractViaMarkItDown(
  bytes: Buffer,
  originalName: string,
  mime: string,
  runner: MarkItDownRunner = defaultRunner,
): Promise<string | null> {
  if (!isMarkItDownCandidate(originalName, mime)) return null;
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;

  const ext = pickExtension(originalName, mime);
  if (!ext) return null;

  const tmpPath = join(tmpdir(), `kioku-mid-${randomBytes(8).toString("hex")}${ext}`);
  try {
    await writeFile(tmpPath, bytes);
    const out = (await runner(tmpPath)).trim();
    return out ? out.slice(0, MAX_OUTPUT) : null;
  } catch (err: any) {
    logger.warn(
      { err: err?.message, originalName, mime },
      "[markitdown] extraction failed — falling back",
    );
    return null;
  } finally {
    void unlink(tmpPath).catch(() => {});
  }
}
