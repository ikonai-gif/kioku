import {
  Crown, Cpu, Network, BarChart2, PenTool,
  Bot, Zap, Shield, Telescope, Layers,
  FlaskConical, Megaphone, Code2, Globe, Star,
} from "lucide-react";

// Map agent name keywords → lucide icon
const iconMap: Array<{ keywords: string[]; Icon: React.ComponentType<any> }> = [
  { keywords: ["kote", "boss", "founder", "ceo", "owner"],        Icon: Crown       },
  { keywords: ["computer", "bro", "execution", "build"],          Icon: Cpu         },
  { keywords: ["agent o", "orchestrat", "coordinator", "manage"], Icon: Network     },
  { keywords: ["analyst", "data", "research", "intel"],           Icon: BarChart2   },
  { keywords: ["writer", "content", "copy", "brand"],             Icon: PenTool     },
  { keywords: ["security", "guard", "shield"],                    Icon: Shield      },
  { keywords: ["search", "scout", "telescope"],                   Icon: Telescope   },
  { keywords: ["lab", "test", "experiment"],                      Icon: FlaskConical},
  { keywords: ["market", "growth", "mega"],                       Icon: Megaphone   },
  { keywords: ["code", "dev", "engineer"],                        Icon: Code2       },
  { keywords: ["global", "world", "international"],               Icon: Globe       },
  { keywords: ["layer", "stack", "arch"],                         Icon: Layers      },
  { keywords: ["flash", "speed", "quick"],                        Icon: Zap         },
  { keywords: ["star", "elite", "vip"],                           Icon: Star        },
];

export function getAgentIcon(name: string): React.ComponentType<any> {
  const lower = name.toLowerCase();
  for (const { keywords, Icon } of iconMap) {
    if (keywords.some(k => lower.includes(k))) return Icon;
  }
  return Bot; // default
}

interface AgentAvatarProps {
  name: string;
  color: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { outer: "w-6 h-6", icon: "w-3 h-3" },
  md: { outer: "w-9 h-9", icon: "w-4 h-4" },
  lg: { outer: "w-11 h-11 rounded-xl", icon: "w-5 h-5" },
};

export function AgentAvatar({ name, color, size = "md", className }: AgentAvatarProps) {
  const Icon = getAgentIcon(name);
  const s = sizes[size];
  return (
    <div
      className={`${s.outer} rounded-full flex items-center justify-center flex-shrink-0 ${className ?? ""}`}
      style={{ background: color + "22", border: `1px solid ${color}44` }}
    >
      <Icon className={s.icon} style={{ color }} />
    </div>
  );
}
