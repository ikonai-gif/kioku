// Diagnostic: call Kimi K2.6 via OpenRouter directly, dump RAW response.
// Goal: figure out where Kimi's visible content lives (content, reasoning, etc).
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: { "HTTP-Referer": "https://usekioku.com", "X-Title": "KIOKU" },
});

async function probe(maxTokens: number) {
  console.log(`\n=== Probe with max_tokens=${maxTokens} ===`);
  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model: "moonshotai/kimi-k2.6",
      max_tokens: maxTokens,
      temperature: 0.6,
      messages: [
        { role: "system", content: "You are an operations expert. Respond in ONE concise English sentence." },
        { role: "user", content: "What is more important for operational resilience next quarter: supplier diversification or process optimization?" },
      ],
    });
    const ms = Date.now() - t0;
    const msg: any = resp.choices?.[0]?.message ?? {};
    console.log(`duration: ${ms}ms`);
    console.log(`finish_reason: ${resp.choices?.[0]?.finish_reason}`);
    console.log(`usage:`, JSON.stringify(resp.usage, null, 2));
    console.log(`message.keys: ${Object.keys(msg).join(", ")}`);
    console.log(`message.content (len=${(msg.content ?? "").length}):`, JSON.stringify((msg.content ?? "").slice(0, 300)));
    if ((msg as any).reasoning) console.log(`message.reasoning (len=${(msg as any).reasoning.length}):`, JSON.stringify((msg as any).reasoning.slice(0, 300)));
    if ((msg as any).reasoning_content) console.log(`message.reasoning_content (len=${(msg as any).reasoning_content.length}):`, JSON.stringify((msg as any).reasoning_content.slice(0, 300)));
    console.log(`raw message JSON: ${JSON.stringify(msg).slice(0, 800)}`);
  } catch (e: any) {
    console.log(`ERROR (${Date.now() - t0}ms): ${e?.message ?? e}`);
  }
}

async function main() {
  await probe(1024);
  await probe(2048);
  await probe(4096);
}

main().then(() => process.exit(0));
