import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { GraduationCap, MessageSquare, Brain, Sliders, ListChecks, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface TrainingConsentData {
  allowTraining: boolean;
  allowedCategories: string[];
}

const CATEGORIES = [
  { id: "conversations", label: "Conversation History", desc: "Learn from how you interact", icon: MessageSquare },
  { id: "memories", label: "Memory Entries", desc: "Improve memory relevance", icon: Brain },
  { id: "preferences", label: "Behavioral Preferences", desc: "Adapt to your style", icon: Sliders },
  { id: "tasks", label: "Task Patterns", desc: "Optimize task execution", icon: ListChecks },
];

export default function TrainingConsent() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<TrainingConsentData>({
    queryKey: ["/api/privacy/training-consent"],
  });

  const [enabled, setEnabled] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);

  useEffect(() => {
    if (data) {
      setEnabled(data.allowTraining);
      setCategories(data.allowedCategories);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: async (payload: { allowTraining: boolean; allowedCategories: string[] }) => {
      const res = await apiRequest("PUT", "/api/privacy/training-consent", payload);
      if (!res.ok) throw new Error("Failed to update");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/privacy/training-consent"] });
      toast({ title: "Training preferences updated" });
    },
    onError: () => toast({ title: "Failed to update", variant: "destructive" }),
  });

  const handleToggle = (val: boolean) => {
    setEnabled(val);
    const newCategories = val ? categories : [];
    mutation.mutate({ allowTraining: val, allowedCategories: newCategories });
  };

  const handleCategoryToggle = (catId: string) => {
    const newCats = categories.includes(catId)
      ? categories.filter(c => c !== catId)
      : [...categories, catId];
    setCategories(newCats);
    mutation.mutate({ allowTraining: enabled, allowedCategories: newCats });
  };

  if (isLoading) {
    return (
      <div className="bg-card border rounded-xl p-5 gold-glow animate-pulse h-48" style={{ borderColor: "hsl(var(--border))" }} />
    );
  }

  return (
    <div className="bg-card border rounded-xl p-5 gold-glow space-y-4" style={{ borderColor: "hsl(var(--border))" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-amber-500/15">
            <GraduationCap className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Training Data Controls</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Allow Luca to learn from our conversations?</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {enabled && (
            <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
              <CheckCircle2 className="w-3 h-3" /> Active
            </span>
          )}
          {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          <Switch checked={enabled} onCheckedChange={handleToggle} />
        </div>
      </div>

      {/* Explanation */}
      <div className="text-xs text-muted-foreground leading-relaxed bg-muted/10 rounded-lg p-3">
        When enabled, KIOKU may use your data to improve personalization and response quality.
        Your data is <strong className="text-foreground">never sold</strong> or shared with third parties.
        You can opt out at any time — this stops all future training without affecting your service.
      </div>

      {/* Category controls */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Category-level controls</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {CATEGORIES.map(({ id, label, desc, icon: Icon }) => {
            const active = enabled && categories.includes(id);
            return (
              <button
                key={id}
                onClick={() => enabled && handleCategoryToggle(id)}
                disabled={!enabled}
                className={cn(
                  "flex items-start gap-3 p-3 rounded-lg border text-left transition-all min-h-[60px]",
                  active
                    ? "bg-green-500/5"
                    : enabled
                    ? "hover:bg-muted/10"
                    : "opacity-50 cursor-not-allowed"
                )}
                style={{ borderColor: active ? "hsl(142 71% 45% / 0.3)" : "hsl(var(--border))" }}
              >
                <div className={cn(
                  "w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0",
                  active ? "bg-green-500/15 text-green-400" : "bg-muted/20 text-muted-foreground"
                )}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-foreground">{label}</span>
                    {active && <CheckCircle2 className="w-3 h-3 text-green-400" />}
                  </div>
                  <span className="text-[10px] text-muted-foreground">{desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
