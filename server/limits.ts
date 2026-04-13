/**
 * KIOKU™ Per-User Resource Limits & AI Quotas
 * Plan-based limits for resource creation and AI usage
 */

export const PLAN_LIMITS: Record<string, { agents: number; memories: number; rooms: number; flows: number; deliberations: number }> = {
  dev:          { agents: 2,    memories: 100,    rooms: 5,    flows: 2,    deliberations: 5 },
  free:         { agents: 2,    memories: 100,    rooms: 5,    flows: 2,    deliberations: 5 },
  starter:      { agents: 5,    memories: 1000,   rooms: 25,   flows: 10,   deliberations: 25 },
  professional: { agents: 15,   memories: 10000,  rooms: 100,  flows: 50,   deliberations: 100 },
  team:         { agents: 50,   memories: 50000,  rooms: 200,  flows: 100,  deliberations: 999999 },
  business:     { agents: 50,   memories: 50000,  rooms: 200,  flows: 100,  deliberations: 999999 },
  enterprise:   { agents: 9999, memories: 999999, rooms: 9999, flows: 9999, deliberations: 999999 },
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

/** Monthly usage limits per plan for metered resources */
export const USAGE_LIMITS: Record<string, {
  deliberations: number;
  apiCalls: number;
  webhookCalls: number;
  tokensUsed: number;
}> = {
  dev:          { deliberations: 25,     apiCalls: 5_000,     webhookCalls: 100,     tokensUsed: 100_000 },
  free:         { deliberations: 25,     apiCalls: 5_000,     webhookCalls: 100,     tokensUsed: 100_000 },
  starter:      { deliberations: 200,    apiCalls: 50_000,    webhookCalls: 1_000,   tokensUsed: 1_000_000 },
  professional: { deliberations: 2_000,  apiCalls: 500_000,   webhookCalls: 10_000,  tokensUsed: 10_000_000 },
  team:         { deliberations: 2_000,  apiCalls: 500_000,   webhookCalls: 10_000,  tokensUsed: 10_000_000 },
  business:     { deliberations: 10_000, apiCalls: 2_000_000, webhookCalls: 50_000,  tokensUsed: 50_000_000 },
  enterprise:   { deliberations: 999_999, apiCalls: 99_999_999, webhookCalls: 999_999, tokensUsed: 999_999_999 },
};

export function getUsageLimits(plan: string) {
  return USAGE_LIMITS[plan] || USAGE_LIMITS.free;
}
