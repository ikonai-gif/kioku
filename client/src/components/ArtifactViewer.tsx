import React, { useState } from "react";
import { Code, Image as ImageIcon, FileText, Download, Copy, Check, ExternalLink, Search } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

export type ArtifactCategory = "code" | "images" | "files";

export interface Artifact {
  id: string;
  type: "code" | "image" | "file" | "result";
  category: ArtifactCategory;
  title: string;
  content: string;
  language?: string;
  url?: string;
  filename?: string;
  timestamp: number;
}

// ── Thumbnail mode (list item) ─────────────────────────────────
function ArtifactThumbnail({ artifact }: { artifact: Artifact }) {
  switch (artifact.type) {
    case "code":
      return (
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(59,130,246,0.1)", border: "1px solid rgba(59,130,246,0.2)" }}
        >
          <Code className="w-4 h-4 text-blue-400" />
        </div>
      );
    case "image":
      return artifact.url ? (
        <div
          className="w-10 h-10 rounded-lg flex-shrink-0 bg-cover bg-center"
          style={{
            backgroundImage: `url(${artifact.url.startsWith("/api/") ? `${API_BASE}${artifact.url}` : artifact.url})`,
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        />
      ) : (
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(201,163,64,0.1)", border: "1px solid rgba(201,163,64,0.2)" }}
        >
          <ImageIcon className="w-4 h-4 text-[#C9A340]" />
        </div>
      );
    case "file":
      return (
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)" }}
        >
          <FileText className="w-4 h-4 text-green-400" />
        </div>
      );
    case "result":
      return (
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.2)" }}
        >
          <Search className="w-4 h-4 text-purple-400" />
        </div>
      );
    default:
      return null;
  }
}

// ── Full mode (detail view) ────────────────────────────────────
function CodeViewer({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        border: "1px solid rgba(201,163,64,0.25)",
        background: "rgba(10,15,46,0.9)",
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{
          background: "rgba(201,163,64,0.08)",
          borderBottom: "1px solid rgba(201,163,64,0.15)",
        }}
      >
        <span className="text-[10px] text-[#C9A340]/70 font-mono">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-[#C9A340]/60 hover:text-[#C9A340] transition-colors px-2 py-0.5 rounded"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-sm leading-relaxed">
        <code className="text-[#e0e0e0] font-mono whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

function ImageViewer({ url, title }: { url: string; title: string }) {
  const resolvedUrl = url.startsWith("/api/") ? `${API_BASE}${url}` : url;
  return (
    <div className="space-y-2">
      <div
        className="rounded-xl overflow-hidden cursor-pointer"
        style={{ border: "1px solid rgba(255,255,255,0.08)" }}
        onClick={() => window.open(resolvedUrl, "_blank")}
      >
        <img
          src={resolvedUrl}
          alt={title}
          className="w-full h-auto"
          loading="lazy"
        />
      </div>
      <div className="flex items-center gap-2">
        <a
          href={resolvedUrl}
          download={title}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{
            background: "rgba(201,163,64,0.1)",
            border: "1px solid rgba(201,163,64,0.2)",
            color: "#C9A340",
          }}
        >
          <Download className="w-3 h-3" />
          Download
        </a>
        <a
          href={resolvedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          <ExternalLink className="w-3 h-3" />
          Open
        </a>
      </div>
    </div>
  );
}

function FileViewer({ artifact }: { artifact: Artifact }) {
  const resolvedUrl = artifact.url
    ? artifact.url.startsWith("/api/")
      ? `${API_BASE}${artifact.url}`
      : artifact.url
    : null;

  return (
    <div className="space-y-3">
      {artifact.content && (
        <div
          className="rounded-xl p-4 text-sm font-mono whitespace-pre-wrap break-words leading-relaxed"
          style={{
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.8)",
          }}
        >
          {artifact.content}
        </div>
      )}
      {resolvedUrl && (
        <a
          href={resolvedUrl}
          download={artifact.filename || artifact.title}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all hover:scale-[1.01]"
          style={{
            background: "rgba(201,163,64,0.1)",
            border: "1px solid rgba(201,163,64,0.25)",
            color: "#C9A340",
          }}
        >
          <Download className="w-4 h-4" />
          Download {artifact.filename || artifact.title}
        </a>
      )}
    </div>
  );
}

function ResultViewer({ content }: { content: string }) {
  return (
    <div
      className="rounded-xl p-4 text-sm whitespace-pre-wrap break-words leading-relaxed"
      style={{
        background: "rgba(0,0,0,0.2)",
        border: "1px solid rgba(168,85,247,0.15)",
        color: "rgba(255,255,255,0.8)",
      }}
    >
      {content}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────
interface ArtifactViewerProps {
  artifact: Artifact;
  mode: "thumbnail" | "full";
}

export function ArtifactViewer({ artifact, mode }: ArtifactViewerProps) {
  if (mode === "thumbnail") {
    return <ArtifactThumbnail artifact={artifact} />;
  }

  switch (artifact.type) {
    case "code":
      return <CodeViewer code={artifact.content} language={artifact.language} />;
    case "image":
      return artifact.url ? (
        <ImageViewer url={artifact.url} title={artifact.title} />
      ) : (
        <ResultViewer content={artifact.content} />
      );
    case "file":
      return <FileViewer artifact={artifact} />;
    case "result":
      return <ResultViewer content={artifact.content} />;
    default:
      return <ResultViewer content={artifact.content} />;
  }
}
