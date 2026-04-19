import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Download, Upload, FileJson, CheckCircle2, AlertCircle, X } from "lucide-react";

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export default function ImportExport() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Export mutation
  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/privacy/export");
      if (!res.ok) throw new Error("Export failed");
      return res.json();
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kioku-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });

  // Import mutation
  const importMutation = useMutation({
    mutationFn: async (data: any) => {
      setImportProgress(30);
      const res = await apiRequest("POST", "/api/privacy/import", { data });
      setImportProgress(80);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Import failed");
      }
      setImportProgress(100);
      return res.json() as Promise<ImportResult>;
    },
    onSuccess: (result) => {
      setImportResult(result);
      setPreviewData(null);
      queryClient.invalidateQueries({ queryKey: ["/api/memories"] });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        setPreviewData(parsed);
        setImportResult(null);
        setImportProgress(0);
      } catch {
        setPreviewData({ _error: "Invalid JSON file" });
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const confirmImport = () => {
    if (!previewData || previewData._error) return;
    importMutation.mutate(previewData);
  };

  const isKiokuFormat = previewData?._meta?.format === "kioku-export";

  return (
    <div className="space-y-6">
      {/* Export Section */}
      <div className="relative overflow-hidden rounded-xl border p-5"
        style={{
          borderColor: "hsl(var(--border))",
          background: "linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card) / 0.8) 100%)",
        }}>
        {/* Gold glow corners */}
        <div className="absolute top-0 left-0 w-16 h-16 pointer-events-none"
          style={{ background: "radial-gradient(circle at top left, rgba(255,215,0,0.08) 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 right-0 w-16 h-16 pointer-events-none"
          style={{ background: "radial-gradient(circle at bottom right, rgba(255,215,0,0.08) 0%, transparent 70%)" }} />

        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
            <Download className="w-5 h-5 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Export My Data</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Download all your memories, conversations (last 90 days), preferences, and connected services as a JSON file.
            </p>
            <Button
              size="sm"
              className="mt-3 h-10 px-5 text-xs font-medium min-w-[120px]"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending}
            >
              {exportMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-current/30 border-t-current animate-spin" />
                  Exporting…
                </span>
              ) : exportMutation.isSuccess ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Downloaded
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <FileJson className="w-3.5 h-3.5" />
                  Export JSON
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Import Section */}
      <div className="relative overflow-hidden rounded-xl border p-5"
        style={{
          borderColor: "hsl(var(--border))",
          background: "linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card) / 0.8) 100%)",
        }}>
        <div className="absolute top-0 left-0 w-16 h-16 pointer-events-none"
          style={{ background: "radial-gradient(circle at top left, rgba(255,215,0,0.08) 0%, transparent 70%)" }} />
        <div className="absolute bottom-0 right-0 w-16 h-16 pointer-events-none"
          style={{ background: "radial-gradient(circle at bottom right, rgba(255,215,0,0.08) 0%, transparent 70%)" }} />

        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
            <Upload className="w-5 h-5 text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Import Data</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Import memories from a KIOKU JSON export. Duplicates will be skipped automatically.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileSelect}
              className="hidden"
            />
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-10 px-5 text-xs font-medium min-w-[120px]"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="w-3.5 h-3.5 mr-2" />
              Choose File
            </Button>
          </div>
        </div>

        {/* Preview */}
        {previewData && !previewData._error && (
          <div className="mt-4 rounded-lg border p-4 space-y-3"
            style={{ borderColor: "hsl(var(--border))", background: "hsl(var(--muted) / 0.3)" }}>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-foreground">Import Preview</h4>
              <button
                onClick={() => { setPreviewData(null); setImportResult(null); }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isKiokuFormat ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md p-2" style={{ background: "hsl(var(--card))" }}>
                    <span className="text-muted-foreground">Memories:</span>{" "}
                    <span className="font-medium text-foreground">{previewData.memories?.length ?? 0}</span>
                  </div>
                  <div className="rounded-md p-2" style={{ background: "hsl(var(--card))" }}>
                    <span className="text-muted-foreground">Conversations:</span>{" "}
                    <span className="font-medium text-foreground">{previewData.conversations?.length ?? 0}</span>
                  </div>
                  <div className="rounded-md p-2" style={{ background: "hsl(var(--card))" }}>
                    <span className="text-muted-foreground">Preferences:</span>{" "}
                    <span className="font-medium text-foreground">{previewData.preferences?.length ?? 0}</span>
                  </div>
                  <div className="rounded-md p-2" style={{ background: "hsl(var(--card))" }}>
                    <span className="text-muted-foreground">Format:</span>{" "}
                    <span className="font-medium text-amber-400">KIOKU v{previewData._meta?.version}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="w-full h-10 text-xs font-medium"
                  onClick={confirmImport}
                  disabled={importMutation.isPending}
                >
                  {importMutation.isPending ? "Importing…" : `Import ${previewData.memories?.length ?? 0} Memories`}
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2 text-xs text-amber-400">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>Unrecognized format. Only KIOKU native JSON exports are supported.</span>
              </div>
            )}

            {importMutation.isPending && (
              <Progress value={importProgress} className="h-1.5" />
            )}
          </div>
        )}

        {previewData?._error && (
          <div className="mt-4 flex items-center gap-2 text-xs text-red-400 p-3 rounded-lg"
            style={{ background: "rgba(239,68,68,0.1)" }}>
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {previewData._error}
          </div>
        )}

        {/* Import Result */}
        {importResult && (
          <div className="mt-4 rounded-lg border p-4 space-y-2"
            style={{
              borderColor: importResult.errors.length > 0 ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)",
              background: importResult.errors.length > 0 ? "rgba(239,68,68,0.05)" : "rgba(34,197,94,0.05)",
            }}>
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              <span className="text-foreground">Import Complete</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="text-center p-2 rounded-md" style={{ background: "hsl(var(--card))" }}>
                <div className="font-bold text-green-400 text-base">{importResult.imported}</div>
                <div className="text-muted-foreground">Imported</div>
              </div>
              <div className="text-center p-2 rounded-md" style={{ background: "hsl(var(--card))" }}>
                <div className="font-bold text-amber-400 text-base">{importResult.skipped}</div>
                <div className="text-muted-foreground">Skipped</div>
              </div>
              <div className="text-center p-2 rounded-md" style={{ background: "hsl(var(--card))" }}>
                <div className="font-bold text-red-400 text-base">{importResult.errors.length}</div>
                <div className="text-muted-foreground">Errors</div>
              </div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="text-[11px] text-red-400/80 space-y-0.5 max-h-24 overflow-y-auto">
                {importResult.errors.slice(0, 5).map((e, i) => (
                  <div key={i}>• {e}</div>
                ))}
                {importResult.errors.length > 5 && (
                  <div className="text-muted-foreground">…and {importResult.errors.length - 5} more</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
