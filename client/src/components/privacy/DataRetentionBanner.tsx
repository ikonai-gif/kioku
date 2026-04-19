import { useState } from "react";
import { Info, X } from "lucide-react";

export default function DataRetentionBanner() {
  const getCookie = () => {
    const match = document.cookie.match(/(?:^|;\s*)kioku_retention_dismissed=([^;]*)/);
    return match ? match[1] === "1" : false;
  };

  const [dismissed, setDismissed] = useState(getCookie);

  const dismiss = () => {
    const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `kioku_retention_dismissed=1; path=/; expires=${expires}; SameSite=Lax; Secure`;
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div className="relative bg-card border rounded-xl p-4 gold-glow" style={{ borderColor: "hsl(43 74% 52% / 0.3)" }}>
      <div className="flex items-start gap-3 pr-8">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-500/15">
          <Info className="w-4 h-4 text-amber-400" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold text-foreground">How We Handle Your Data</h3>
          <ul className="space-y-1 text-[11px] text-muted-foreground leading-relaxed">
            <li className="flex items-start gap-1.5">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <span>Your memories are stored securely and encrypted at rest</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <span>Data is never sold or shared with third parties</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <span>You can export or delete all your data at any time</span>
            </li>
            <li className="flex items-start gap-1.5">
              <span className="text-green-400 mt-0.5">&#10003;</span>
              <span>Training on your data is opt-in — off by default</span>
            </li>
          </ul>
        </div>
      </div>
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
