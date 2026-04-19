import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { ProvenanceNode } from "./ProvenanceNode";

interface TreeNode {
  id: string;
  topic: string;
  decision: string | null;
  confidence: number | null;
  status: string;
  depth: number;
  startedAt: number;
  children: TreeNode[];
}

interface ProvenanceTreeProps {
  chainId: string;
  onSelectNode?: (nodeId: string) => void;
}

function flattenTree(node: TreeNode, result: TreeNode[] = []): TreeNode[] {
  result.push(node);
  if (node.children) {
    for (const child of node.children) {
      flattenTree(child, result);
    }
  }
  return result;
}

export function ProvenanceTree({ chainId, onSelectNode }: ProvenanceTreeProps) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTree() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiRequest("GET", `/api/provenance/${chainId}/tree`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to load tree" }));
          throw new Error(err.error || "Failed to load provenance tree");
        }
        const data = await res.json();
        if (!cancelled) setTree(data);
      } catch (e: any) {
        if (!cancelled) setError(e.message || "Failed to load tree");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTree();
    return () => { cancelled = true; };
  }, [chainId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 text-[#C9A340] animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="text-center py-8">
        <p className="text-xs text-muted-foreground/40">No provenance data</p>
      </div>
    );
  }

  const nodes = flattenTree(tree);

  return (
    <div className="space-y-1.5">
      {nodes.map((node, idx) => (
        <React.Fragment key={node.id}>
          {/* Connection line */}
          {idx > 0 && node.depth > 0 && (
            <div
              className="h-4 w-[2px] rounded-full"
              style={{
                marginLeft: node.depth * 20 + 11,
                background: "linear-gradient(180deg, rgba(201,163,64,0.3), rgba(201,163,64,0.1))",
              }}
            />
          )}
          <ProvenanceNode
            id={node.id}
            topic={node.topic}
            decision={node.decision}
            confidence={node.confidence}
            status={node.status}
            depth={node.depth}
            startedAt={node.startedAt}
            isSelected={selectedId === node.id}
            onClick={() => {
              setSelectedId(node.id);
              onSelectNode?.(node.id);
            }}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
