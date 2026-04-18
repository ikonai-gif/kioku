import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  BookOpen, Plus, Trash2, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronUp, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const CATEGORY_BADGES: Record<string, { label: string; color: string }> = {
  art: { label: "Art", color: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  music: { label: "Music", color: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  fashion: { label: "Fashion", color: "bg-pink-500/20 text-pink-300 border-pink-500/30" },
  law: { label: "Law", color: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
  construction: { label: "Construction", color: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
  beauty: { label: "Beauty", color: "bg-rose-500/20 text-rose-300 border-rose-500/30" },
  custom: { label: "Custom", color: "bg-gray-500/20 text-gray-300 border-gray-500/30" },
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  loading: <Loader2 className="w-4 h-4 animate-spin text-yellow-400" />,
  ready: <CheckCircle className="w-4 h-4 text-emerald-400" />,
  error: <AlertCircle className="w-4 h-4 text-red-400" />,
};

interface KnowledgeDomain {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  chunkCount: number;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface Template {
  slug: string;
  name: string;
  category: string;
  description: string;
}

function DomainCard({ domain, onDelete }: { domain: KnowledgeDomain; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const badge = CATEGORY_BADGES[domain.category] || CATEGORY_BADGES.custom;
  const { toast } = useToast();

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/knowledge/domains/${domain.slug}`);
      if (!res.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      toast({ title: "Domain deleted" });
      onDelete();
    },
    onError: () => {
      toast({ title: "Delete failed", variant: "destructive" });
    },
  });

  return (
    <div className="rounded-xl border border-white/10 hover:border-[#C9A340]/20 transition-all duration-300 overflow-hidden"
      style={{ background: "rgba(255,255,255,0.03)" }}>
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {STATUS_ICONS[domain.status] || STATUS_ICONS.loading}
            <h3 className="text-sm font-medium text-foreground">{domain.name}</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full border", badge.color)}>
              {badge.label}
            </span>
            {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
          </div>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{domain.chunkCount} chunks</span>
          <span className="capitalize">{domain.status}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3">
          {domain.description && (
            <p className="text-xs text-muted-foreground/70 leading-relaxed">{domain.description}</p>
          )}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground/40">
              Created {new Date(domain.createdAt).toLocaleDateString()}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10"
              onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(); }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="w-3 h-3 mr-1" />
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddDomainForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("custom");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [useTemplate, setUseTemplate] = useState(false);
  const { toast } = useToast();

  const { data: templates } = useQuery<Template[]>({ queryKey: ["/api/knowledge/templates"] });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/knowledge/domains", {
        name, slug, category, description,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create domain");
      }
      return res.json();
    },
    onSuccess: async () => {
      if (useTemplate) {
        // Generate from template
        await apiRequest("POST", `/api/knowledge/domains/${slug}/generate`);
        toast({ title: "Domain created", description: "Generating knowledge from template..." });
      } else if (content.trim()) {
        // Load raw content
        await apiRequest("POST", `/api/knowledge/domains/${slug}/load`, { content });
        toast({ title: "Domain created", description: "Loading knowledge..." });
      } else {
        toast({ title: "Domain created", description: "Add content later via the load endpoint." });
      }
      setName(""); setCategory("custom"); setDescription(""); setContent(""); setUseTemplate(false);
      onCreated();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const applyTemplate = (tpl: Template) => {
    setName(tpl.name);
    setCategory(tpl.category);
    setDescription(tpl.description);
    setUseTemplate(true);
  };

  return (
    <div className="rounded-xl border border-[#C9A340]/20 p-4 space-y-4"
      style={{ background: "rgba(201,163,64,0.03)" }}>
      <h3 className="text-sm font-medium text-[#C9A340] flex items-center gap-2">
        <Plus className="w-4 h-4" /> Add Knowledge Domain
      </h3>

      {/* Template quick-picks */}
      {templates && templates.length > 0 && (
        <div>
          <p className="text-[10px] text-muted-foreground/50 mb-2 uppercase tracking-wider">Quick Start Templates</p>
          <div className="flex flex-wrap gap-1.5">
            {templates.map(tpl => (
              <button
                key={tpl.slug}
                onClick={() => applyTemplate(tpl)}
                className={cn(
                  "text-[10px] px-2.5 py-1 rounded-full border transition-colors",
                  name === tpl.name
                    ? "bg-[#C9A340]/20 text-[#C9A340] border-[#C9A340]/40"
                    : "border-white/10 text-muted-foreground/60 hover:text-muted-foreground hover:border-white/20"
                )}
              >
                <Sparkles className="w-2.5 h-2.5 inline mr-1" />
                {tpl.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <input
          type="text"
          placeholder="Domain name (e.g. Art History)"
          value={name}
          onChange={e => { setName(e.target.value); setUseTemplate(false); }}
          className="w-full px-3 py-2 text-sm bg-background/50 border border-white/10 rounded-lg
            text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-[#C9A340]/40"
        />

        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-background/50 border border-white/10 rounded-lg
            text-foreground focus:outline-none focus:border-[#C9A340]/40"
        >
          <option value="art">Art</option>
          <option value="music">Music</option>
          <option value="fashion">Fashion</option>
          <option value="law">Law</option>
          <option value="construction">Construction</option>
          <option value="beauty">Beauty</option>
          <option value="custom">Custom</option>
        </select>

        <input
          type="text"
          placeholder="Description (optional)"
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-background/50 border border-white/10 rounded-lg
            text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-[#C9A340]/40"
        />

        {!useTemplate && (
          <textarea
            placeholder="Paste knowledge content here (paragraphs will be auto-chunked)..."
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={6}
            className="w-full px-3 py-2 text-sm bg-background/50 border border-white/10 rounded-lg
              text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-[#C9A340]/40
              resize-y min-h-[120px]"
          />
        )}

        {useTemplate && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#C9A340]/10 border border-[#C9A340]/20">
            <Sparkles className="w-4 h-4 text-[#C9A340]" />
            <span className="text-xs text-[#C9A340]">Knowledge will be auto-generated from template</span>
          </div>
        )}

        <Button
          onClick={() => createMutation.mutate()}
          disabled={!name.trim() || !slug || createMutation.isPending}
          className="w-full bg-[#C9A340] hover:bg-[#C9A340]/90 text-black font-medium"
        >
          {createMutation.isPending ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</>
          ) : useTemplate ? (
            <><Sparkles className="w-4 h-4 mr-2" /> Create & Generate</>
          ) : (
            <><BookOpen className="w-4 h-4 mr-2" /> Load Knowledge</>
          )}
        </Button>
      </div>
    </div>
  );
}

export default function KnowledgePage() {
  const [showForm, setShowForm] = useState(false);

  const { data: domains, isLoading } = useQuery<KnowledgeDomain[]>({
    queryKey: ["/api/knowledge/domains"],
    refetchInterval: 5000, // Poll for status updates
  });

  const refreshDomains = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/knowledge/domains"] });
  };

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-[#C9A340]" />
            Knowledge Base
          </h1>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Structured knowledge domains for Luca
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs border-[#C9A340]/30 text-[#C9A340] hover:bg-[#C9A340]/10"
          onClick={() => setShowForm(!showForm)}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          {showForm ? "Cancel" : "Add Domain"}
        </Button>
      </div>

      {/* Add form */}
      {showForm && <AddDomainForm onCreated={() => { setShowForm(false); refreshDomains(); }} />}

      {/* Domain list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[#C9A340]" />
        </div>
      ) : !domains || domains.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <BookOpen className="w-10 h-10 mx-auto text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/50">No knowledge domains yet</p>
          <p className="text-xs text-muted-foreground/30">
            Add domains to give Luca specialized expertise
          </p>
          {!showForm && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-[#C9A340]/30 text-[#C9A340] hover:bg-[#C9A340]/10"
              onClick={() => setShowForm(true)}
            >
              <Plus className="w-3.5 h-3.5 mr-1" /> Get Started
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {domains.map(domain => (
            <DomainCard key={domain.id} domain={domain} onDelete={refreshDomains} />
          ))}
        </div>
      )}
    </div>
  );
}
