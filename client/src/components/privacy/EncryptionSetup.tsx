import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { deriveKey, generateRecoveryKey } from "@/lib/encryption";
import { Button } from "@/components/ui/button";
import { Shield, ShieldCheck, Lock, Key, Copy, CheckCircle2, Eye, EyeOff, ChevronRight } from "lucide-react";

type SetupStep = "intro" | "passphrase" | "recovery" | "confirm";

export default function EncryptionSetup() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SetupStep>("intro");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [salt, setSalt] = useState("");
  const [setupError, setSetupError] = useState("");

  const { data: encStatus } = useQuery<{ enabled: boolean; hasSalt: boolean }>({
    queryKey: ["/api/encryption/status"],
  });

  const setupMutation = useMutation({
    mutationFn: async (saltVal: string) => {
      const res = await apiRequest("POST", "/api/encryption/setup", { salt: saltVal });
      if (!res.ok) throw new Error("Setup failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/encryption/status"] });
    },
  });

  const handleGenerateKey = async () => {
    if (passphrase.length < 8) {
      setSetupError("Passphrase must be at least 8 characters");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setSetupError("Passphrases do not match");
      return;
    }
    setSetupError("");

    try {
      const { salt: derivedSalt } = await deriveKey(passphrase);
      setSalt(derivedSalt);
      const recovery = generateRecoveryKey();
      setRecoveryKey(recovery);
      setStep("recovery");
    } catch {
      setSetupError("Failed to generate encryption key. Please try again.");
    }
  };

  const handleCopyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopiedRecovery(true);
      setTimeout(() => setCopiedRecovery(false), 3000);
    } catch {
      // Fallback: select text
    }
  };

  const handleConfirm = () => {
    setupMutation.mutate(salt);
    setStep("confirm");
  };

  // If already enabled, show status
  if (encStatus?.enabled) {
    return (
      <div className="relative overflow-hidden rounded-xl border p-5"
        style={{
          borderColor: "rgba(34,197,94,0.3)",
          background: "linear-gradient(135deg, hsl(var(--card)) 0%, hsl(var(--card) / 0.8) 100%)",
        }}>
        <div className="absolute top-0 left-0 w-16 h-16 pointer-events-none"
          style={{ background: "radial-gradient(circle at top left, rgba(34,197,94,0.1) 0%, transparent 70%)" }} />

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)" }}>
            <ShieldCheck className="w-5 h-5 text-green-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              End-to-End Encryption
              <span className="text-[10px] font-medium text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded border border-green-400/20">
                Active
              </span>
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your sensitive memories are encrypted client-side. Only you can read them.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
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

      {/* Step: Intro */}
      {step === "intro" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
              <Shield className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Enable End-to-End Encryption</h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Protect your most sensitive memories with client-side encryption. When enabled, selected memories are encrypted on your device before being stored. Not even KIOKU servers can read them.
              </p>
            </div>
          </div>

          <div className="space-y-2 pl-[52px]">
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="w-3.5 h-3.5 mt-0.5 text-amber-400 flex-shrink-0" />
              <span>AES-256-GCM encryption — military-grade security</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Key className="w-3.5 h-3.5 mt-0.5 text-amber-400 flex-shrink-0" />
              <span>Your passphrase never leaves your device</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="w-3.5 h-3.5 mt-0.5 text-amber-400 flex-shrink-0" />
              <span>Recovery key ensures you never lose access</span>
            </div>
          </div>

          <div className="pl-[52px]">
            <Button
              size="sm"
              className="h-10 px-5 text-xs font-medium"
              onClick={() => setStep("passphrase")}
            >
              <Shield className="w-3.5 h-3.5 mr-2" />
              Set Up Encryption
              <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}

      {/* Step: Passphrase */}
      {step === "passphrase" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
              <Key className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Create Your Passphrase</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Choose a strong passphrase (8+ characters). This will be used to derive your encryption key.
              </p>
            </div>
          </div>

          <div className="space-y-3 pl-[52px]">
            <div className="relative">
              <input
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter passphrase…"
                className="w-full h-11 rounded-lg border px-3 pr-10 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
                style={{ borderColor: "hsl(var(--border))" }}
              />
              <button
                type="button"
                onClick={() => setShowPassphrase(!showPassphrase)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <input
              type="password"
              value={confirmPassphrase}
              onChange={(e) => setConfirmPassphrase(e.target.value)}
              placeholder="Confirm passphrase…"
              className="w-full h-11 rounded-lg border px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-amber-400/30"
              style={{ borderColor: "hsl(var(--border))" }}
            />

            {setupError && (
              <p className="text-xs text-red-400">{setupError}</p>
            )}

            {passphrase.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "hsl(var(--muted))" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.min(100, (passphrase.length / 16) * 100)}%`,
                      background: passphrase.length < 8 ? "#ef4444" : passphrase.length < 12 ? "#f59e0b" : "#22c55e",
                    }}
                  />
                </div>
                <span className={passphrase.length < 8 ? "text-red-400" : passphrase.length < 12 ? "text-amber-400" : "text-green-400"}>
                  {passphrase.length < 8 ? "Weak" : passphrase.length < 12 ? "Good" : "Strong"}
                </span>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-10 px-4 text-xs"
                onClick={() => { setStep("intro"); setPassphrase(""); setConfirmPassphrase(""); setSetupError(""); }}
              >
                Back
              </Button>
              <Button
                size="sm"
                className="h-10 px-5 text-xs font-medium flex-1"
                onClick={handleGenerateKey}
                disabled={passphrase.length < 8 || !confirmPassphrase}
              >
                Generate Key
                <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Step: Recovery Key */}
      {step === "recovery" && (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: "rgba(255,215,0,0.1)", border: "1px solid rgba(255,215,0,0.2)" }}>
              <Key className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Save Your Recovery Key</h3>
              <p className="text-xs text-red-400 mt-1 font-medium">
                Save this key somewhere safe. If you forget your passphrase, this is the only way to recover access.
              </p>
            </div>
          </div>

          <div className="space-y-3 pl-[52px]">
            <div className="p-4 rounded-lg border font-mono text-sm leading-relaxed break-all text-amber-400"
              style={{
                borderColor: "rgba(255,215,0,0.2)",
                background: "rgba(255,215,0,0.05)",
              }}>
              {recoveryKey}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="w-full h-10 text-xs"
              onClick={handleCopyRecovery}
            >
              {copiedRecovery ? (
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  Copied!
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Copy className="w-3.5 h-3.5" />
                  Copy Recovery Key
                </span>
              )}
            </Button>

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-10 px-4 text-xs"
                onClick={() => setStep("passphrase")}
              >
                Back
              </Button>
              <Button
                size="sm"
                className="h-10 px-5 text-xs font-medium flex-1"
                onClick={handleConfirm}
                disabled={!copiedRecovery}
              >
                {copiedRecovery ? "Enable Encryption" : "Copy Key First"}
                <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Step: Confirm */}
      {step === "confirm" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{
                background: setupMutation.isSuccess ? "rgba(34,197,94,0.1)" : "rgba(255,215,0,0.1)",
                border: setupMutation.isSuccess ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,215,0,0.2)",
              }}>
              {setupMutation.isPending ? (
                <div className="w-5 h-5 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
              ) : setupMutation.isSuccess ? (
                <ShieldCheck className="w-5 h-5 text-green-400" />
              ) : (
                <Shield className="w-5 h-5 text-red-400" />
              )}
            </div>
            <div>
              {setupMutation.isPending && (
                <>
                  <h3 className="text-sm font-semibold text-foreground">Setting up encryption…</h3>
                  <p className="text-xs text-muted-foreground">Storing your encryption configuration securely.</p>
                </>
              )}
              {setupMutation.isSuccess && (
                <>
                  <h3 className="text-sm font-semibold text-green-400">Encryption Enabled!</h3>
                  <p className="text-xs text-muted-foreground">Your sensitive memories are now protected with E2E encryption.</p>
                </>
              )}
              {setupMutation.isError && (
                <>
                  <h3 className="text-sm font-semibold text-red-400">Setup Failed</h3>
                  <p className="text-xs text-muted-foreground">Something went wrong. Please try again.</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-8 text-xs"
                    onClick={() => setStep("intro")}
                  >
                    Try Again
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
