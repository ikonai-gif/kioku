import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Shield, Download, Trash2, Loader2, AlertTriangle } from "lucide-react";
import DataOverview from "@/components/privacy/DataOverview";
import MemoryBrowser from "@/components/privacy/MemoryBrowser";
import TrainingConsent from "@/components/privacy/TrainingConsent";
import DataRetentionBanner from "@/components/privacy/DataRetentionBanner";

export default function PrivacyDashboardPage() {
  const { toast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/privacy/data-request");
      if (!res.ok) throw new Error("Export failed");
      return res.json();
    },
    onSuccess: (data) => {
      // Download as JSON file
      const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kioku-data-export-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Data exported successfully" });
    },
    onError: () => toast({ title: "Export failed", variant: "destructive" }),
  });

  const deleteAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/privacy/account-data", {
        confirmToken: "DELETE_ALL_MY_DATA",
      });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onSuccess: () => {
      setShowDeleteConfirm(false);
      setDeleteConfirmText("");
      toast({ title: "All data deleted" });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  return (
    <div className="p-5 max-w-4xl mx-auto space-y-6 pb-24">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: "hsl(43 74% 52% / 0.12)", border: "1px solid hsl(43 74% 52% / 0.25)" }}
        >
          <Shield className="w-5 h-5" style={{ color: "hsl(43 74% 52%)" }} />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Privacy & Security</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Manage your data, privacy settings, and training preferences</p>
        </div>
      </div>

      {/* Data Retention Banner */}
      <DataRetentionBanner />

      {/* Data Overview */}
      <DataOverview />

      {/* Training Consent */}
      <TrainingConsent />

      {/* Memory Browser */}
      <div className="bg-card border rounded-xl p-5 gold-glow" style={{ borderColor: "hsl(var(--border))" }}>
        <MemoryBrowser />
      </div>

      {/* Data Actions */}
      <div className="bg-card border rounded-xl p-5 gold-glow space-y-4" style={{ borderColor: "hsl(var(--border))" }}>
        <h2 className="text-sm font-semibold text-foreground">Data Actions</h2>

        {/* Export */}
        <div className="flex items-center justify-between p-3 rounded-lg border" style={{ borderColor: "hsl(var(--border))" }}>
          <div>
            <p className="text-sm font-medium text-foreground">Request My Data</p>
            <p className="text-xs text-muted-foreground mt-0.5">Download a full export of your data (GDPR Art. 20)</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-9 text-xs"
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
          >
            {exportMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <Download className="w-3.5 h-3.5 mr-1.5" />
            )}
            Export
          </Button>
        </div>

        {/* Danger Zone */}
        <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: "hsl(0 72% 50% / 0.3)" }}>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <h3 className="text-xs font-semibold text-red-400">Danger Zone</h3>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Permanently delete all your data including memories, agents, flows, rooms, and logs.
            This action cannot be undone.
          </p>

          {!showDeleteConfirm ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-9 text-xs"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete All My Data
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-red-400 font-medium">
                Type "DELETE" to confirm permanent deletion:
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={e => setDeleteConfirmText(e.target.value)}
                placeholder="Type DELETE to confirm"
                className="w-full h-10 px-3 rounded-md text-sm bg-background border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-red-500/30"
                style={{ borderColor: "hsl(0 72% 50% / 0.3)" }}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-9 text-xs"
                  disabled={deleteConfirmText !== "DELETE" || deleteAllMutation.isPending}
                  onClick={() => deleteAllMutation.mutate()}
                >
                  {deleteAllMutation.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : (
                    <Trash2 className="w-3 h-3 mr-1" />
                  )}
                  Confirm Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 text-xs"
                  onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
