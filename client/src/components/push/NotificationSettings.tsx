import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, BellOff, BellRing, Sun, CheckCircle2, Bot, Send } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { apiRequest, API_BASE } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

// Cookie helpers (no localStorage per project rules)
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
function setCookie(name: string, value: string, days = 365) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${expires}; SameSite=Lax; Secure`;
}

const CATEGORY_META = [
  { key: "daily_brief", label: "Daily Brief", desc: "Morning summary & schedule", icon: Sun },
  { key: "task_complete", label: "Task Complete", desc: "Agent task completion alerts", icon: CheckCircle2 },
  { key: "agent_alert", label: "Agent Alert", desc: "Important agent notifications", icon: Bot },
] as const;

type Category = typeof CATEGORY_META[number]["key"];

async function getVapidKey(): Promise<string> {
  const res = await apiRequest("GET", "/api/push/vapid-key");
  const data = await res.json();
  return data.publicKey;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function NotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "default"
  );
  const [subscribed, setSubscribed] = useState(false);
  const [categories, setCategories] = useState<Category[]>(["daily_brief", "task_complete", "agent_alert"]);
  const [loading, setLoading] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [swSupported] = useState(() => "serviceWorker" in navigator && "PushManager" in window);

  // Load saved categories from cookie
  useEffect(() => {
    const saved = getCookie("kioku_push_categories");
    if (saved) {
      try { setCategories(JSON.parse(saved)); } catch {}
    }
  }, []);

  // Check if already subscribed
  useEffect(() => {
    if (!swSupported) return;
    navigator.serviceWorker.ready.then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setSubscribed(!!sub);
      });
    });
  }, [swSupported]);

  const subscribe = useCallback(async () => {
    if (!swSupported) return;
    setLoading(true);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        setLoading(false);
        return;
      }

      const vapidKey = await getVapidKey();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisuallyPromested: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      } as any);

      const subJson = sub.toJSON();
      await apiRequest("POST", "/api/push/subscribe", {
        endpoint: subJson.endpoint,
        keys: subJson.keys,
        categories,
      });

      setSubscribed(true);
      setCookie("kioku_push_enabled", "true");
      setCookie("kioku_push_categories", JSON.stringify(categories));
    } catch (err) {
      console.error("Push subscription failed:", err);
    } finally {
      setLoading(false);
    }
  }, [swSupported, categories]);

  const unsubscribe = useCallback(async () => {
    if (!swSupported) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await apiRequest("POST", "/api/push/unsubscribe", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setCookie("kioku_push_enabled", "false");
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
    } finally {
      setLoading(false);
    }
  }, [swSupported]);

  const toggleCategory = useCallback(async (cat: Category) => {
    const next = categories.includes(cat)
      ? categories.filter((c) => c !== cat)
      : [...categories, cat];
    setCategories(next);
    setCookie("kioku_push_categories", JSON.stringify(next));

    // Update on server if subscribed
    if (subscribed) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await apiRequest("PATCH", "/api/push/categories", {
            endpoint: sub.endpoint,
            categories: next,
          });
        }
      } catch {}
    }
  }, [categories, subscribed]);

  const sendTest = useCallback(async () => {
    setTestSent(false);
    try {
      await apiRequest("POST", "/api/push/test");
      setTestSent(true);
      setTimeout(() => setTestSent(false), 3000);
    } catch {}
  }, []);

  const notSupported = !swSupported;
  const denied = permission === "denied";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, rgba(255,215,0,0.15), rgba(212,175,55,0.08))" }}>
          <Bell className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Push Notifications</h3>
          <p className="text-xs text-muted-foreground">
            {notSupported
              ? "Not supported in this browser"
              : denied
              ? "Notifications blocked — update browser settings"
              : subscribed
              ? "Notifications enabled"
              : "Get notified about daily briefs & agent alerts"}
          </p>
        </div>
      </div>

      {/* Main toggle */}
      {!notSupported && !denied && (
        <div
          className="relative rounded-xl p-4 overflow-hidden"
          style={{
            background: "linear-gradient(135deg, rgba(10,14,26,0.95), rgba(15,22,40,0.9))",
            border: "1px solid rgba(212,175,55,0.15)",
          }}
        >
          {/* Gold glow corners */}
          <div className="absolute top-0 left-0 w-16 h-16 pointer-events-none"
            style={{ background: "radial-gradient(circle at 0% 0%, rgba(255,215,0,0.08), transparent 70%)" }} />
          <div className="absolute bottom-0 right-0 w-16 h-16 pointer-events-none"
            style={{ background: "radial-gradient(circle at 100% 100%, rgba(255,215,0,0.08), transparent 70%)" }} />

          <div className="flex items-center justify-between relative z-10">
            <div className="flex items-center gap-3">
              <motion.div
                animate={subscribed ? { scale: [1, 1.15, 1] } : {}}
                transition={{ duration: 0.5, repeat: subscribed ? Infinity : 0, repeatDelay: 3 }}
              >
                {subscribed ? (
                  <BellRing className="w-5 h-5 text-amber-400" />
                ) : (
                  <BellOff className="w-5 h-5 text-muted-foreground" />
                )}
              </motion.div>
              <div>
                <span className="text-sm font-medium text-foreground">
                  {subscribed ? "Notifications Active" : "Enable Notifications"}
                </span>
              </div>
            </div>
            <Switch
              checked={subscribed}
              onCheckedChange={(checked) => (checked ? subscribe() : unsubscribe())}
              disabled={loading}
            />
          </div>
        </div>
      )}

      {/* Category toggles */}
      <AnimatePresence>
        {subscribed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-2 overflow-hidden"
          >
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
              Notification Categories
            </p>
            {CATEGORY_META.map(({ key, label, desc, icon: Icon }) => (
              <div
                key={key}
                className="flex items-center justify-between rounded-lg px-3 py-2.5"
                style={{
                  background: "rgba(10,14,26,0.6)",
                  border: "1px solid rgba(212,175,55,0.08)",
                }}
              >
                <div className="flex items-center gap-3">
                  <Icon className={cn(
                    "w-4 h-4",
                    categories.includes(key) ? "text-amber-400" : "text-muted-foreground"
                  )} />
                  <div>
                    <span className="text-sm text-foreground">{label}</span>
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  </div>
                </div>
                <Switch
                  checked={categories.includes(key)}
                  onCheckedChange={() => toggleCategory(key)}
                />
              </div>
            ))}

            {/* Test notification button */}
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2 text-xs gap-2"
              style={{ borderColor: "rgba(212,175,55,0.2)" }}
              onClick={sendTest}
            >
              <Send className="w-3.5 h-3.5" />
              {testSent ? "Notification Sent!" : "Send Test Notification"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Blocked state */}
      {denied && (
        <div className="rounded-lg p-3 text-xs text-muted-foreground"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)" }}>
          Notifications are blocked. To enable, update your browser notification settings for this site.
        </div>
      )}

      {/* Unsupported state */}
      {notSupported && (
        <div className="rounded-lg p-3 text-xs text-muted-foreground"
          style={{ background: "rgba(10,14,26,0.6)", border: "1px solid rgba(212,175,55,0.08)" }}>
          Push notifications require a modern browser with service worker support. Try Chrome, Edge, or Firefox.
        </div>
      )}
    </div>
  );
}
