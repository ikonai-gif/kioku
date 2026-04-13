import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Sparkles, Users, CheckCircle2, MessageSquare, Rocket,
  ChevronRight, ChevronLeft, Loader2, Crown, Lightbulb, Shield,
} from "lucide-react";
import { AgentAvatar } from "@/lib/agent-icon";
import { cn } from "@/lib/utils";

interface Template {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  agents: Array<{ name: string; role: string; color: string; description: string }>;
}

const TEMPLATES: Template[] = [
  {
    id: "executive-board",
    name: "Executive Board",
    icon: <Crown className="w-5 h-5" />,
    description: "C-suite team for strategic decisions, finance, legal, and operations",
    agents: [
      { name: "CFO-Agent", role: "finance", color: "#4ade80", description: "Financial analysis, budget approvals, cost optimization" },
      { name: "Legal-Agent", role: "legal", color: "#60a5fa", description: "Contract review, compliance checks, regulatory analysis" },
      { name: "Strategy-Agent", role: "strategy", color: "#c084fc", description: "Market research, competitive intelligence, growth planning" },
      { name: "Ops-Agent", role: "operations", color: "#f59e0b", description: "Infrastructure, process optimization, risk management" },
    ],
  },
  {
    id: "product-team",
    name: "Product Team",
    icon: <Lightbulb className="w-5 h-5" />,
    description: "Product development trio for roadmaps, design, and engineering",
    agents: [
      { name: "PM-Agent", role: "product", color: "#34d399", description: "Product roadmap, feature prioritization, user stories" },
      { name: "Design-Agent", role: "design", color: "#f472b6", description: "UX research, design systems, accessibility reviews" },
      { name: "Engineering-Agent", role: "engineering", color: "#38bdf8", description: "Architecture decisions, technical feasibility, code quality" },
    ],
  },
  {
    id: "advisory-council",
    name: "Advisory Council",
    icon: <Shield className="w-5 h-5" />,
    description: "Risk, innovation, and market experts for strategic guidance",
    agents: [
      { name: "Risk-Agent", role: "risk", color: "#ef4444", description: "Risk assessment, scenario planning, mitigation strategies" },
      { name: "Innovation-Agent", role: "innovation", color: "#a78bfa", description: "Emerging tech evaluation, R&D recommendations, patents" },
      { name: "Market-Agent", role: "market", color: "#fb923c", description: "Market analysis, customer insights, pricing strategy" },
    ],
  },
];

const STEP_LABELS = ["Welcome", "Choose Team", "Confirm", "Deliberate", "Ready"];

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 justify-center mb-6">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={cn(
              "w-2 h-2 rounded-full transition-all duration-300",
              i === current
                ? "w-6 bg-[#D4AF37] shadow-[0_0_8px_rgba(212,175,55,0.5)]"
                : i < current
                  ? "bg-[#D4AF37]/60"
                  : "bg-white/10"
            )}
          />
        </div>
      ))}
    </div>
  );
}

export default function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [createdRoom, setCreatedRoom] = useState<any>(null);
  const [createdAgents, setCreatedAgents] = useState<any[]>([]);
  const [createProgress, setCreateProgress] = useState(0);

  const createTeamMutation = useMutation({
    mutationFn: async (templateId: string) => {
      setCreateProgress(10);
      const res = await apiRequest("POST", `/api/agents/templates/${templateId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create team");
      }
      setCreateProgress(80);
      const data = await res.json();
      setCreateProgress(100);
      return data;
    },
    onSuccess: (data) => {
      setCreatedAgents(data.agents);
      setCreatedRoom(data.room);
      queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rooms"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `${selectedTemplate?.name} created!` });
      setStep(3);
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
      setCreateProgress(0);
    },
  });

  const handleCreateTeam = () => {
    if (!selectedTemplate) return;
    createTeamMutation.mutate(selectedTemplate.id);
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#070D1A]/90 backdrop-blur-sm" />

      {/* Wizard card — glass-morphism */}
      <div className="relative w-full max-w-lg mx-auto rounded-2xl border border-[#D4AF37]/20 bg-gradient-to-b from-[#0D1526]/95 to-[#070D1A]/95 backdrop-blur-xl shadow-[0_0_60px_rgba(212,175,55,0.08)] overflow-hidden">
        {/* Gold glow corners */}
        <div className="absolute top-0 left-0 w-24 h-24 bg-[#D4AF37]/5 rounded-full blur-2xl -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute top-0 right-0 w-24 h-24 bg-[#D4AF37]/5 rounded-full blur-2xl translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-[#D4AF37]/5 rounded-full blur-2xl -translate-x-1/2 translate-y-1/2" />
        <div className="absolute bottom-0 right-0 w-24 h-24 bg-[#D4AF37]/5 rounded-full blur-2xl translate-x-1/2 translate-y-1/2" />

        <div className="relative p-6 sm:p-8">
          <StepIndicator current={step} total={5} />

          {/* Step 0: Welcome */}
          {step === 0 && (
            <div className="text-center space-y-5 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto">
                <Sparkles className="w-7 h-7 text-[#D4AF37]" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">Welcome to KIOKU™</h2>
                <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto leading-relaxed">
                  KIOKU is a multi-agent deliberation platform. Your AI agents discuss, debate, and reach consensus on any topic.
                </p>
              </div>
              <div className="bg-[#D4AF37]/5 border border-[#D4AF37]/10 rounded-xl p-4 text-left space-y-2">
                <p className="text-xs text-[#D4AF37] font-medium">How it works:</p>
                <div className="space-y-1.5">
                  {[
                    "Create a team of AI agents with unique roles",
                    "Open a deliberation room and pose a question",
                    "Watch agents debate and reach consensus",
                  ].map((text, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-[10px] text-[#D4AF37] mt-0.5 font-bold">{i + 1}.</span>
                      <span className="text-xs text-muted-foreground">{text}</span>
                    </div>
                  ))}
                </div>
              </div>
              <Button
                className="w-full h-11 text-sm font-semibold gap-2"
                style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                onClick={() => setStep(1)}
              >
                Let's set up your first team <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}

          {/* Step 1: Choose Template */}
          {step === 1 && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="text-center">
                <h2 className="text-lg font-bold text-foreground">Choose a Team Template</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Pick a pre-built team or start from scratch
                </p>
              </div>

              <div className="space-y-3">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    className={cn(
                      "w-full text-left rounded-xl border p-4 transition-all duration-200",
                      selectedTemplate?.id === tpl.id
                        ? "border-[#D4AF37]/50 bg-[#D4AF37]/5 shadow-[0_0_20px_rgba(212,175,55,0.1)]"
                        : "border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]"
                    )}
                    onClick={() => setSelectedTemplate(tpl)}
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center",
                        selectedTemplate?.id === tpl.id ? "bg-[#D4AF37]/20 text-[#D4AF37]" : "bg-white/5 text-muted-foreground"
                      )}>
                        {tpl.icon}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-foreground">{tpl.name}</div>
                        <div className="text-[10px] text-muted-foreground">{tpl.agents.length} agents</div>
                      </div>
                      {selectedTemplate?.id === tpl.id && (
                        <CheckCircle2 className="w-4 h-4 text-[#D4AF37] ml-auto" />
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{tpl.description}</p>
                    <div className="flex gap-1.5 mt-2 flex-wrap">
                      {tpl.agents.map((a) => (
                        <span
                          key={a.name}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-white/5 bg-white/[0.03]"
                          style={{ color: a.color }}
                        >
                          {a.name}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>

              <div className="flex gap-3 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 text-xs gap-1 text-muted-foreground"
                  onClick={() => setStep(0)}
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </Button>
                <Button
                  className="flex-1 h-10 text-sm font-semibold gap-2"
                  style={{ background: selectedTemplate ? "hsl(43 74% 52%)" : "hsl(222 15% 25%)", color: selectedTemplate ? "hsl(222 47% 8%)" : "hsl(222 15% 50%)" }}
                  disabled={!selectedTemplate}
                  onClick={() => setStep(2)}
                >
                  Review Team <ChevronRight className="w-4 h-4" />
                </Button>
              </div>

              <button
                className="w-full text-center text-[11px] text-muted-foreground/60 hover:text-[#D4AF37] transition-colors py-1"
                onClick={onComplete}
              >
                Skip — I'll create agents manually
              </button>
            </div>
          )}

          {/* Step 2: Confirm & Create */}
          {step === 2 && selectedTemplate && (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="text-center">
                <h2 className="text-lg font-bold text-foreground">Confirm Your Team</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  These agents will be created with a dedicated room
                </p>
              </div>

              <div className="space-y-2">
                {selectedTemplate.agents.map((agent, idx) => (
                  <div
                    key={agent.name}
                    className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
                    style={{
                      animationDelay: `${idx * 80}ms`,
                      animation: "fadeIn 0.3s ease-out forwards",
                      opacity: 0,
                    }}
                  >
                    <AgentAvatar name={agent.name} color={agent.color} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">{agent.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{agent.description}</div>
                    </div>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full border"
                      style={{ color: agent.color, borderColor: agent.color + "30" }}
                    >
                      {agent.role}
                    </span>
                  </div>
                ))}
              </div>

              {/* Progress bar during creation */}
              {createTeamMutation.isPending && (
                <div className="space-y-2">
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#D4AF37] rounded-full transition-all duration-500"
                      style={{ width: `${createProgress}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground text-center">
                    Creating {selectedTemplate.agents.length} agents and room...
                  </p>
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-10 text-xs gap-1 text-muted-foreground"
                  onClick={() => setStep(1)}
                  disabled={createTeamMutation.isPending}
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Back
                </Button>
                <Button
                  className="flex-1 h-10 text-sm font-semibold gap-2"
                  style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                  onClick={handleCreateTeam}
                  disabled={createTeamMutation.isPending}
                >
                  {createTeamMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</>
                  ) : (
                    <><Users className="w-4 h-4" /> Create Team</>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: First Deliberation */}
          {step === 3 && (
            <div className="text-center space-y-5 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto">
                <MessageSquare className="w-7 h-7 text-[#D4AF37]" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-foreground">Team Created!</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  Your <span className="text-[#D4AF37]">{selectedTemplate?.name}</span> is ready.
                  Start your first deliberation to see them in action.
                </p>
              </div>

              {createdRoom && (
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 text-left">
                  <p className="text-[10px] text-muted-foreground mb-2">SUGGESTED TOPIC</p>
                  <p className="text-sm text-foreground italic">
                    "Should we invest in AI-powered customer support?"
                  </p>
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    {createdAgents.map((a: any) => (
                      <span
                        key={a.id}
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.03]"
                        style={{ color: a.color }}
                      >
                        {a.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {createdRoom && (
                  <a href={`#/rooms/${createdRoom.id}`} className="block">
                    <Button
                      className="w-full h-11 text-sm font-semibold gap-2"
                      style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                      onClick={() => {
                        onComplete();
                      }}
                    >
                      <MessageSquare className="w-4 h-4" /> Open Room & Start Deliberating
                    </Button>
                  </a>
                )}
                <Button
                  variant="ghost"
                  className="w-full h-9 text-xs text-muted-foreground"
                  onClick={() => setStep(4)}
                >
                  Skip to dashboard
                </Button>
              </div>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 4 && (
            <div className="text-center space-y-5 animate-in fade-in duration-300">
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto">
                <Rocket className="w-7 h-7 text-[#D4AF37]" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">Your KIOKU™ is Ready!</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  Explore your workspace and start making decisions with AI agents.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <a href="#/agents" onClick={onComplete}>
                  <div className="w-full rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left hover:border-[#D4AF37]/20 hover:bg-[#D4AF37]/5 transition-all cursor-pointer">
                    <div className="text-sm font-medium text-foreground">Agents</div>
                    <div className="text-[10px] text-muted-foreground">Manage your AI team members</div>
                  </div>
                </a>
                <a href="#/rooms" onClick={onComplete}>
                  <div className="w-full rounded-lg border border-white/5 bg-white/[0.02] p-3 text-left hover:border-[#D4AF37]/20 hover:bg-[#D4AF37]/5 transition-all cursor-pointer">
                    <div className="text-sm font-medium text-foreground">Rooms</div>
                    <div className="text-[10px] text-muted-foreground">Deliberation rooms for debates</div>
                  </div>
                </a>
              </div>

              <Button
                className="w-full h-11 text-sm font-semibold gap-2"
                style={{ background: "hsl(43 74% 52%)", color: "hsl(222 47% 8%)" }}
                onClick={onComplete}
              >
                Go to Dashboard <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
