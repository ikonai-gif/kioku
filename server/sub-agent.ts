import OpenAI from "openai";

interface SubAgentTask {
  objective: string;
  tools?: string[];
  maxIterations?: number;
  model?: string;
}

interface SubAgentResult {
  success: boolean;
  result: string;
  toolsUsed: string[];
  iterations: number;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema?: Record<string, any>;
}

const DEFAULT_TOOLS = ["web_search", "read_url", "run_code", "creative_writing"];

export async function runSubAgent(
  task: SubAgentTask,
  userId: number,
  agentId: number,
  executeToolFn: (name: string, args: Record<string, any>, userId: number, agentId: number) => Promise<string>,
  allTools: ToolDef[]
): Promise<SubAgentResult> {
  const model = task.model || "gpt-4.1-mini";
  const maxIter = Math.min(task.maxIterations || 5, 8);
  const toolsUsed: string[] = [];

  const allowedTools = task.tools || DEFAULT_TOOLS;

  // Filter tool definitions to only the ones this sub-agent can use
  // Always exclude delegation tools to prevent recursion
  const BLOCKED_TOOLS = ["delegate_task", "delegate_parallel"];
  const filteredTools = allTools.filter(t => allowedTools.includes(t.name) && !BLOCKED_TOOLS.includes(t.name));

  const systemPrompt = `You are a focused research sub-agent. Your ONLY job is to complete this specific task:

${task.objective}

Rules:
- Stay focused on the task. Do not go off-topic.
- Use tools when needed to gather information or perform actions.
- Be thorough but concise.
- When done, provide a clear, structured summary of your findings.
- Do NOT ask follow-up questions. Complete the task with what you have.
- Maximum ${maxIter} tool calls. Use them wisely.`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task.objective },
  ];

  const openai = new OpenAI();

  const oaiTools: OpenAI.Chat.ChatCompletionTool[] = filteredTools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));

  for (let i = 0; i < maxIter; i++) {
    const completion = await openai.chat.completions.create({
      model,
      max_tokens: 1500,
      temperature: 0.3,
      messages,
      ...(oaiTools.length > 0 ? { tools: oaiTools } : {}),
    });

    const msg = completion.choices[0]?.message;
    if (!msg?.tool_calls || msg.tool_calls.length === 0) {
      return { success: true, result: msg?.content?.trim() || "", toolsUsed, iterations: i + 1 };
    }

    messages.push(msg);
    for (const tc of msg.tool_calls) {
      const tcAny = tc as any;
      let args: Record<string, any> = {};
      try { args = JSON.parse(tcAny.function.arguments || "{}"); } catch { /* malformed JSON */ }
      const result = await executeToolFn(tcAny.function.name, args, userId, agentId);
      toolsUsed.push(tcAny.function.name);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  // Exhausted iterations — do one final call without tools to get a summary
  const final = await openai.chat.completions.create({
    model,
    max_tokens: 1500,
    messages,
  });
  return { success: true, result: final.choices[0]?.message?.content?.trim() || "", toolsUsed, iterations: maxIter };
}
