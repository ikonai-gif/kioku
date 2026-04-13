/**
 * KIOKU™ Per-User Resource Limits & AI Quotas
 * Plan-based limits for resource creation and AI usage
 */

export const PLAN_LIMITS: Record<string, { agents: number; memories: number; rooms: number; flows: number }> = {
  dev:          { agents: 5,    memories: 500,   rooms: 10,   flows: 5 },
  free:         { agents: 5,    memories: 500,   rooms: 10,   flows: 5 },
  starter:      { agents: 20,   memories: 5000,  rooms: 50,   flows: 20 },
  professional: { agents: 100,  memories: 50000, rooms: 200,  flows: 100 },
  team:         { agents: 100,  memories: 50000, rooms: 200,  flows: 100 },
  business:     { agents: 100,  memories: 50000, rooms: 200,  flows: 100 },
  enterprise:   { agents: 9999, memories: 999999, rooms: 9999, flows: 9999 },
};

export function getLimits(plan: string) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
}

export const AI_QUOTAS: Record<string, { dailyCalls: number; monthlyTokens: number }> = {
  dev:          { dailyCalls: 20,    monthlyTokens: 100000 },
  free:         { dailyCalls: 20,    monthlyTokens: 100000 },
  starter:      { dailyCalls: 200,   monthlyTokens: 1000000 },
  professional: { dailyCalls: 2000,  monthlyTokens: 10000000 },
  team:         { dailyCalls: 2000,  monthlyTokens: 10000000 },
  business:     { dailyCalls: 2000,  monthlyTokens: 10000000 },
  enterprise:   { dailyCalls: 99999, monthlyTokens: 999999999 },
};
