import { QueryClient } from "@tanstack/react-query";
import { getSessionToken, handleUnauth } from "./auth";

// Determine base URL (handles deploy proxy via __PORT_5000__)
const rawBase = typeof window !== "undefined"
  ? (window as any).__API_BASE__ ?? ""
  : "";

export const API_BASE = rawBase.replace("__PORT_5000__", window.location.origin + "/port/5000");

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = getSessionToken();
  if (token) headers["x-session-token"] = token;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    handleUnauth();
  }

  return res;
}

const defaultQueryFn = async ({ queryKey }: { queryKey: readonly unknown[] }) => {
  const path = Array.isArray(queryKey) ? (queryKey[0] as string) : (queryKey as unknown as string);
  const res = await apiRequest("GET", path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "Request failed");
  }
  return res.json();
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: defaultQueryFn,
      staleTime: 10_000,
      retry: 1,
    },
  },
});
