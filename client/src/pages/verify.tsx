import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "../App";

export default function VerifyPage() {
  const [, navigate] = useLocation();
  const { login } = useAuth();
  const [status, setStatus] = useState<"verifying" | "error">("verifying");
  const [msg, setMsg] = useState("Verifying your link…");

  useEffect(() => {
    // Support both hash-based (#/verify?token=...) and query string (?token=...)
    const hashSearch = window.location.hash.split("?")[1] ?? "";
    const querySearch = window.location.search.slice(1);
    const params = new URLSearchParams(hashSearch || querySearch);
    const token = params.get("token");

    if (!token) {
      setStatus("error");
      setMsg("Invalid link — no token found.");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    fetch("/api/auth/verify-magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.sessionToken) {
          login(data.sessionToken, data.user);
          navigate("/");
        } else {
          setStatus("error");
          setMsg(data.error || "Link expired or invalid. Please request a new one.");
        }
      })
      .catch((err) => {
        setStatus("error");
        setMsg(err?.name === "AbortError" ? "Verification timed out. Please try again." : "Network error. Please try again.");
      })
      .finally(() => clearTimeout(timeout));
  }, [login, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8">
        {status === "verifying" ? (
          <>
            <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-muted-foreground">{msg}</p>
          </>
        ) : (
          <>
            <p className="text-destructive font-medium">{msg}</p>
            <button
              onClick={() => navigate("/")}
              className="text-primary underline text-sm"
            >
              Back to login
            </button>
          </>
        )}
      </div>
    </div>
  );
}
