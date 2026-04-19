import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Shield, ShieldCheck, Download, Upload, Lock, Trash2,
  Loader2, AlertTriangle, ArrowLeft,
} from "lucide-react";
import { Link } from "wouter";
import DataOverview from "@/components/privacy/DataOverview";
import MemoryBrowser from "@/components/privacy/MemoryBrowser";
import TrainingConsent from "@/components/privacy/TrainingConsent";
import DataRetentionBanner from "@/components/privacy/DataRetentionBanner";
import ImportExport from "@/components/privacy/ImportExport";
import EncryptionSetup from "@/components/privacy/EncryptionSetup";

export default function PrivacyDashboardPage() {
  const { toast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const { data: encStatus } = useQuery<{ enabled: boolean; hasSalt: boolean }>({
    queryKey: ["/api/encryption/status"],
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/privacy/data-request");
      if (!res.ok) throw new Error("Export failed");
      return res.json();
    },
    onSuccess: (data) => {
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
    <div className="min-h-[100dvh] md:min-h-0 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-6 pb-24 md:pb-6 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/partner">
            <a className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors md:hidden"
              style={{ background: "hsl(var(--muted) / 0.3)" }}>
              <ArrowLeft className="w-4 h-4" />
            </a>
          </Link>
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}
          >
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground tracking-tight">Privacy & Security</h1>
            <p className="text-xs text-muted-foreground">Manage your data, encryption, and privacy settings</p>
          </div>
        </div>

        {/* Data Retention Banner */}
        <DataRetentionBanner />

        {/* Status Cards */}
        <div className="grid grid-cols-2 gap-3">
          <div className="relative overflow-hidden rounded-xl border p-4"
            style={{
              borderColor: "hsl(var(--border))",
              background: "linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card) / 0.8) 100%)",
            }}>
            <div className="absolute top-0 left-0 w-12 h-12 pointer-events-none"
              style={{ background: "radial-gradient(circle at top left, rgba(255,215,0,0.08) 0%, transparent 70%)" }} />
            <div className="flex items-center gap-2 mb-2">
              <Download className="w-4 h-4 text-amber-400" />
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Export</span>
            </div>
            <div className="text-xs text-foreground font-medium">Ready</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">Full data export available</div>
          </div>

          <div className="relative overflow-hidden rounded-xl border p-4"
            style={{
              borderColor: encStatus?.enabled ? "rgba(34,197,94,0.3)" : "hsl(var(--border))",
              background: "linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card) / 0.8) 100%)",
            }}>
            <div className="absolute top-0 left-0 w-12 h-12 pointer-events-none"
              style={{
                background: encStatus?.enabled
                  ? "radial-gradient(circle at top left, rgba(34,197,94,0.1) 0%, transparent 70%)"
                  : "radial-gradient(circle at top left, rgba(255,215,0,0.08) 0%, transparent 70%)",
              }} />
            <div className="flex items-center gap-2 mb-2">
              {encStatus?.enabled ? (
                <ShieldCheck className="w-4 h-4 text-green-400" />
              ) : (
                <Lock className="w-4 h-4 text-amber-400" />
              )}
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">E2E</span>
            </div>
            <div className="text-xs font-medium" style={{ color: encStatus?.enabled ? "#22c55e" : "hsl(var(--foreground))" }}>
              {encStatus?.enabled ? "Active" : "Not Set Up"}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {encStatus?.enabled ? "Memories encrypted" : "Enable below"}
            </div>
          </div>
        </div>

        {/* Data Overview */}
        <DataOverview />

        {/* Training Consent */}
        <TrainingConsent />

        {/* Encryption Setup */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Shield className="w-4 h-4 text-amber-400" />
            Encryption
          </h2>
          <EncryptionSetup />
        </section>

        {/* Import/Export */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
            <Upload className="w-4 h-4 text-amber-400" />
            Data Import & Export
          </h2>
          <ImportExport />
        </section>

        {/* Memory Browser */}
        <div className="bg-card border rounded-xl p-5 gold-glow" style={{ borderColor: "hsl(var(--border))" }}>
          <MemoryBrowser />
        </div>

        {/* Data Actions */}
        <div className="bg-card border rounded-xl p-5 gold-glow space-y-4" style={{ borderColor: "hsl(var(--border))" }}>
          <h2 className="text-sm font-semibold text-foreground">Data Actions</h2>

          {/* GDPR Export */}
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

        {/* Footer Links */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground/60 pt-2">
          <a href="#/privacy" className="hover:text-foreground underline underline-offset-2">Privacy Policy</a>
          <a href="#/terms" className="hover:text-foreground underline underline-offset-2">Terms of Service</a>
          <a href="#/cookies" className="hover:text-foreground underline underline-offset-2">Cookie Policy</a>
        </div>

      </div>
    </div>
  );
}
