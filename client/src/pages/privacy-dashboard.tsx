import { useQuery } from "@tanstack/react-query";
import { Shield, ShieldCheck, Download, Upload, Lock, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import ImportExport from "@/components/privacy/ImportExport";
import EncryptionSetup from "@/components/privacy/EncryptionSetup";

export default function PrivacyDashboardPage() {
  const { data: encStatus } = useQuery<{ enabled: boolean; hasSalt: boolean }>({
    queryKey: ["/api/encryption/status"],
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
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
            <Shield className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground tracking-tight">Privacy & Security</h1>
            <p className="text-xs text-muted-foreground">Manage your data, encryption, and privacy settings</p>
          </div>
        </div>

        {/* Status cards */}
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

        {/* Links */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground/60 pt-2">
          <a href="#/privacy" className="hover:text-foreground underline underline-offset-2">Privacy Policy</a>
          <a href="#/terms" className="hover:text-foreground underline underline-offset-2">Terms of Service</a>
          <a href="#/cookies" className="hover:text-foreground underline underline-offset-2">Cookie Policy</a>
        </div>

      </div>
    </div>
  );
}
