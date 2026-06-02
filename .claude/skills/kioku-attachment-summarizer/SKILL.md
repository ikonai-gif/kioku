---
name: kioku-attachment-summarizer
description: How the attachment summarizer extracts text from uploads (images, voice, pdf, office docs) and how to add a new extractor safely. Use when touching attachment summarization, file text extraction, or MarkItDown.
---

# KIOKU — attachment summarizer

## Pipeline
Entry: `server/lib/attachment-summarizer.ts` → `summarizeAttachment()`. It is
**fire-and-forget**: called non-blocking after a room_message persists. The DB is
the source of truth; never throw up the stack — log and swallow.

Concurrency is limited in-process (`MAX_PARALLEL = 3`, FIFO queue — deliberately
no `p-limit`/extra npm dep).

Routing by attachment type:
- `image` / `video_frame` → Anthropic Claude vision (caption + OCR hint).
- `voice` → OpenAI Whisper transcription.
- `file` → `summarizeFile()`:
  - PDF (`application/pdf` / `.pdf`) → dynamic-import `pdf-parse`.
  - text (`text/*` / `.txt .md .csv .json .log`) → utf8 slice (≤200k).
  - everything else (docx/xlsx/pptx/html/epub …) → **MarkItDown** (below).
- else → `"[type] original_name"` placeholder.

## MarkItDown (subprocess v1)
`server/lib/markitdown.ts` → `extractViaMarkItDown(bytes, name, mime, runner?)`
shells out to `python3 -m markitdown <tmpfile>` (same Docker image, **no
sidecar**). Guards: MIME/extension allowlist, 15 MB size cap, 45 s timeout, 200k
output cap, temp-file cleanup. **Best-effort**: any failure (binary missing,
timeout, oversize, non-zero exit) returns `null` and the caller falls back to the
placeholder. The `runner` arg is an injection seam so tests don't spawn a real CLI.

Dockerfile installs `markitdown[docx,xlsx,pptx]` **non-fatally** (`|| echo WARN`)
so a failed install never breaks the image build — only the extras we use, to
avoid heavy deps (magika/onnxruntime).

## Adding a new extractor
Add a branch in `summarizeFile` (or a new `server/lib/*` module) following the
same contract: **best-effort, returns null on failure, caller falls back**. Keep
size/timeout caps and temp cleanup. Add deterministic unit tests via an injected
runner — no real subprocess in CI.
