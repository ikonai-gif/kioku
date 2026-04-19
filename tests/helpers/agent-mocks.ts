/**
 * Mock factories for Agent O / Luca tool chain E2E tests.
 * Mocks external services: OpenAI, E2B, Anthropic, fetch, browser-agent.
 */

import { vi } from "vitest";

// ── Mock: OpenAI Client ────────────────────────────────────────────────

export function createMockOpenAIClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: overrides.content ?? "Mock AI response",
              tool_calls: overrides.tool_calls ?? undefined,
            },
            finish_reason: overrides.finish_reason ?? "stop",
          }],
        }),
      },
    },
    images: {
      generate: vi.fn().mockResolvedValue({
        data: [{
          url: overrides.imageUrl ?? "https://mock-image.example.com/img.png",
          revised_prompt: overrides.revisedPrompt ?? "A mock revised prompt",
        }],
      }),
    },
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({
          text: overrides.transcription ?? "Mock transcription text",
          language: "en",
          duration: 30,
        }),
      },
    },
  };
}

// ── Mock: E2B Sandbox ──────────────────────────────────────────────────

export function createMockSandbox(overrides: Partial<Record<string, any>> = {}) {
  return {
    runCode: vi.fn().mockResolvedValue({
      logs: {
        stdout: overrides.stdout ?? ["Hello World"],
        stderr: overrides.stderr ?? [],
      },
      text: overrides.text ?? "",
      error: overrides.error ?? null,
      results: overrides.results ?? [],
    }),
    commands: {
      run: vi.fn().mockResolvedValue({
        stdout: overrides.cmdStdout ?? "",
        stderr: overrides.cmdStderr ?? "",
        exitCode: overrides.exitCode ?? 0,
      }),
    },
    files: {
      write: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(
        overrides.fileContent ?? Buffer.from("mock file content")
      ),
    },
    setTimeoutMs: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Mock: Anthropic Client ─────────────────────────────────────────────

export function createMockAnthropicClient(overrides: Partial<Record<string, any>> = {}) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: overrides.content ?? [{ type: "text", text: "Mock Claude response" }],
        stop_reason: overrides.stop_reason ?? "end_turn",
      }),
    },
  };
}

// ── Mock: Fetch (global) ───────────────────────────────────────────────

export function createMockFetch(overrides: Partial<Record<string, any>> = {}) {
  return vi.fn().mockResolvedValue({
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    text: vi.fn().mockResolvedValue(overrides.text ?? "<html><body>Mock page content</body></html>"),
    json: vi.fn().mockResolvedValue(overrides.json ?? {}),
    arrayBuffer: vi.fn().mockResolvedValue(
      overrides.arrayBuffer ?? new ArrayBuffer(0)
    ),
    headers: {
      get: vi.fn().mockImplementation((name: string) => {
        if (name === "content-type") return overrides.contentType ?? "text/html";
        return null;
      }),
    },
  });
}

// ── Mock: Sub-Agent ────────────────────────────────────────────────────

export function createMockSubAgentResult(overrides: Partial<Record<string, any>> = {}) {
  return {
    success: overrides.success ?? true,
    result: overrides.result ?? "Sub-agent completed task successfully",
    toolsUsed: overrides.toolsUsed ?? ["web_search"],
    iterations: overrides.iterations ?? 2,
  };
}

// ── Mock: Browser Agent ────────────────────────────────────────────────

export function createMockBrowseResult(overrides: Partial<Record<string, any>> = {}) {
  return {
    success: overrides.success ?? true,
    title: overrides.title ?? "Mock Page Title",
    url: overrides.url ?? "https://example.com",
    text: overrides.text ?? "Mock extracted page text",
    screenshot: overrides.screenshot ?? null,
    error: overrides.error ?? null,
  };
}
