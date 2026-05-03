/**
 * Phase 3 (R-luca-computer-ui): generic file preview overlay.
 *
 * Replaces Phase 2's screenshot-only `MediaLightbox`. Renders inline preview
 * for PDF (pdf.js, first N pages, lazy-loaded) and source code
 * (react-syntax-highlighter, lazy-loaded). Falls back to "Открыть в новой
 * вкладке" for any unsupported MIME or oversize PDF.
 *
 * Both heavy dependencies are dynamic-imported so they are NOT in the main
 * bundle. The bundle paid only when a user opens a file lightbox at least
 * once per session.
 *
 * BRO1 R434 must-fixes:
 *   - #3 PDF size gate: MAX_PDF_BYTES = 10MB \u2192 fallback to external link.
 *   - #4 No prismjs + dangerouslySetInnerHTML \u2014 react-syntax-highlighter
 *     emits React elements via createElement (auto-escaped).
 */

import { useEffect, useState, useMemo, useRef, lazy, Suspense } from "react";
import { ExternalLink, X, FileText, FileCode, FileImage, FileQuestion, Loader2 } from "lucide-react";

export interface FileLightboxMedia {
  signedUrl: string;
  contentType: string;
  kind: "screenshot" | "file" | "video";
  sourceUrl?: string | null;
  sizeBytes?: number;
}

const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB

interface Props {
  media: FileLightboxMedia;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isImage(ct: string): boolean {
  return /^image\//i.test(ct);
}

function isPdf(ct: string): boolean {
  return /^application\/pdf$/i.test(ct);
}

function isText(ct: string): boolean {
  return /^text\//i.test(ct) || /^application\/json$/i.test(ct);
}

function langForContentType(ct: string): string {
  // Map MIME \u2192 react-syntax-highlighter language token.
  if (/json/i.test(ct)) return "json";
  if (/markdown/i.test(ct)) return "markdown";
  if (/x-typescript/i.test(ct)) return "typescript";
  if (/x-javascript|javascript/i.test(ct)) return "javascript";
  if (/x-python|python/i.test(ct)) return "python";
  if (/x-go/i.test(ct)) return "go";
  if (/x-rust/i.test(ct)) return "rust";
  if (/x-shell|x-sh/i.test(ct)) return "bash";
  if (/csv/i.test(ct)) return "text";
  return "text";
}

function IconForContentType({ ct, className }: { ct: string; className?: string }) {
  if (isImage(ct)) return <FileImage className={className} />;
  if (isPdf(ct)) return <FileText className={className} />;
  if (isText(ct)) return <FileCode className={className} />;
  return <FileQuestion className={className} />;
}

// ── PDF preview ───────────────────────────────────────────────────────

const MAX_PDF_PAGES_RENDERED = 10;

function PdfPreview({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pdfDoc: any = null;

    (async () => {
      try {
        // Dynamic import keeps pdf.js out of the main bundle.
        const pdfjsLib: any = await import("pdfjs-dist");
        // Vite-friendly worker: ?worker import emits a compiled chunk under
        // 'self' origin. Worker source then runs as a blob: URL — covered by
        // the Phase 3 CSP `workerSrc: ['self','blob:']` directive.
        const PdfWorker: any = (
          await import("pdfjs-dist/build/pdf.worker.min.mjs?worker" as any)
        ).default;
        pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

        const loadingTask = pdfjsLib.getDocument({ url });
        pdfDoc = await loadingTask.promise;
        if (cancelled) return;

        const total = pdfDoc.numPages || 0;
        const renderable = Math.min(total, MAX_PDF_PAGES_RENDERED);
        setPageCount(total);

        const container = containerRef.current;
        if (!container) return;

        for (let i = 1; i <= renderable; i++) {
          if (cancelled) return;
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 1.3 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = "100%";
          canvas.style.maxWidth = "900px";
          canvas.style.marginBottom = "12px";
          canvas.style.borderRadius = "4px";
          canvas.style.background = "#fff";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || "PDF render failed");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      // pdf.js documents aren't strictly required to be destroyed but it
      // releases worker memory faster.
      try { pdfDoc?.destroy?.(); } catch { /* best-effort */ }
    };
  }, [url]);

  if (error) {
    return (
      <div className="text-[12px] text-red-300 p-4">
        Не удалось отобразить PDF: {error}.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          Открыть в новой вкладке
        </a>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight: "85vh" }}>
      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70 p-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загружаю PDF…
        </div>
      )}
      <div ref={containerRef} className="flex flex-col items-center px-2" />
      {pageCount > MAX_PDF_PAGES_RENDERED && (
        <div className="text-[11px] text-muted-foreground/70 text-center pb-3">
          Показаны первые {MAX_PDF_PAGES_RENDERED} из {pageCount} страниц.{" "}
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
            Открыть всё в новой вкладке
          </a>
        </div>
      )}
    </div>
  );
}

// ── Code / text preview ───────────────────────────────────────────────

const MAX_TEXT_BYTES = 1 * 1024 * 1024; // 1MB \u2014 protect main thread

const SyntaxHighlighter: any = lazy(async () => {
  // Dynamic import \u2014 keeps highlighter + theme off the main bundle.
  const [{ Light }, themeMod] = await Promise.all([
    import("react-syntax-highlighter"),
    import("react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark"),
  ]);
  // Register only the languages we actually use, to keep the chunk small.
  const langs = await Promise.all([
    import("react-syntax-highlighter/dist/esm/languages/hljs/javascript"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/typescript"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/python"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/json"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/markdown"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/bash"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/go"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/rust"),
    import("react-syntax-highlighter/dist/esm/languages/hljs/plaintext"),
  ]);
  const names = ["javascript","typescript","python","json","markdown","bash","go","rust","plaintext"];
  langs.forEach((m: any, i: number) => Light.registerLanguage(names[i], m.default));
  const theme = (themeMod as any).default;
  // Default export = thin wrapper.
  return {
    default: (props: any) => (
      <Light language={props.language || "plaintext"} style={theme} customStyle={{ margin: 0, padding: 16, background: "#1e1e1e" }}>
        {props.children}
      </Light>
    ),
  };
});

function CodePreview({ url, contentType }: { url: string; contentType: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const lenHeader = Number(res.headers.get("Content-Length") || 0);
        if (Number.isFinite(lenHeader) && lenHeader > MAX_TEXT_BYTES) {
          setTooLarge(true);
          return;
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        if (buf.byteLength > MAX_TEXT_BYTES) {
          setTooLarge(true);
          return;
        }
        setText(new TextDecoder("utf-8", { fatal: false }).decode(buf));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "fetch failed");
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const lang = useMemo(() => langForContentType(contentType), [contentType]);

  if (error) {
    return (
      <div className="text-[12px] text-red-300 p-4">
        Не удалось загрузить файл: {error}.{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          Открыть в новой вкладке
        </a>
      </div>
    );
  }
  if (tooLarge) {
    return (
      <div className="text-[12px] text-muted-foreground/80 p-4">
        Файл слишком большой для предпросмотра (&gt; 1 МБ).{" "}
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline">
          Открыть в новой вкладке
        </a>
      </div>
    );
  }
  if (text == null) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70 p-3">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Загружаю файл…
      </div>
    );
  }

  return (
    <div className="overflow-auto rounded text-[12px]" style={{ maxHeight: "85vh", maxWidth: "95vw" }}>
      <Suspense
        fallback={
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground/70 p-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Подсветка синтаксиса…
          </div>
        }
      >
        <SyntaxHighlighter language={lang}>{text}</SyntaxHighlighter>
      </Suspense>
    </div>
  );
}

// ── Lightbox shell ────────────────────────────────────────────────────

export function FileLightbox({ media, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ct = media.contentType || "";
  const oversizePdf = isPdf(ct) && (media.sizeBytes || 0) > MAX_PDF_BYTES;

  let body: React.ReactNode;
  if (isImage(ct)) {
    body = (
      <img
        src={media.signedUrl}
        alt="file preview"
        className="max-w-[95vw] max-h-[90vh] object-contain rounded"
        style={{ border: "1px solid rgba(201,163,64,0.3)" }}
      />
    );
  } else if (isPdf(ct) && !oversizePdf) {
    body = <PdfPreview url={media.signedUrl} />;
  } else if (isPdf(ct) && oversizePdf) {
    body = (
      <div className="text-[12px] text-muted-foreground/80 p-6 max-w-md">
        PDF слишком большой для предпросмотра ({(media.sizeBytes! / 1024 / 1024).toFixed(1)} МБ &gt; 10 МБ).
        <div className="mt-3">
          <a
            href={media.signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[#C9A340]"
            style={{ background: "rgba(0,0,0,0.6)", border: "1px solid rgba(201,163,64,0.3)" }}
          >
            <ExternalLink className="w-3 h-3" /> Открыть в новой вкладке
          </a>
        </div>
      </div>
    );
  } else if (isText(ct)) {
    body = <CodePreview url={media.signedUrl} contentType={ct} />;
  } else {
    body = (
      <div className="text-[12px] text-muted-foreground/80 p-6 max-w-md">
        Предпросмотр для типа <span className="font-mono">{ct || "unknown"}</span> недоступен.
        <div className="mt-3">
          <a
            href={media.signedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-[#C9A340]"
            style={{ background: "rgba(0,0,0,0.6)", border: "1px solid rgba(201,163,64,0.3)" }}
          >
            <ExternalLink className="w-3 h-3" /> Открыть в новой вкладке
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.92)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр файла"
    >
      <div
        className="relative max-w-[95vw] max-h-[95vh]"
        onClick={(e) => e.stopPropagation()}
        style={{ background: "rgba(20,20,28,0.95)", borderRadius: 8, border: "1px solid rgba(201,163,64,0.2)" }}
      >
        {body}
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {(media.sourceUrl || media.signedUrl) && (
            <a
              href={media.sourceUrl || media.signedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-md"
              style={{
                background: "rgba(0,0,0,0.6)",
                color: "#C9A340",
                border: "1px solid rgba(201,163,64,0.3)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
              Открыть
            </a>
          )}
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="p-1.5 rounded-md"
            style={{
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              border: "1px solid rgba(255,255,255,0.2)",
            }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export { IconForContentType };
