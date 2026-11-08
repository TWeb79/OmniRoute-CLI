// Translates Anthropic /v1/messages ↔ OpenAI /v1/chat/completions

import type { ChatCompletionRequest } from "./types.js";

interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | Block[];
  source?: { type: string; media_type?: string; data?: string; url?: string };
}
interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string | Block[] }[];
  system?: string | Block[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type: string; name?: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  [key: string]: unknown;
}

const textOf = (c: string | Block[] | undefined, sep = ""): string =>
  typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(sep);

export function toOpenAI(body: AnthropicRequest): ChatCompletionRequest {
  const messages: Record<string, unknown>[] = [];
  if (body.system) messages.push({ role: "system", content: textOf(body.system, "\n") });

  for (const m of body.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const text = textOf(m.content);
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      messages.push({ role: "assistant", content: text || null, ...(calls.length && { tool_calls: calls }) });
    } else {
      // tool results become their own "tool" messages, which must directly follow the assistant tool_calls
      for (const b of m.content.filter((b) => b.type === "tool_result")) {
        messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: textOf(b.content, "\n") });
      }
      const images = m.content.filter((b) => b.type === "image" && b.source).map((b) => ({
        type: "image_url",
        image_url: { url: b.source!.type === "base64" ? `data:${b.source!.media_type};base64,${b.source!.data}` : b.source!.url },
      }));
      if (images.length) messages.push({ role: m.role, content: [...(text ? [{ type: "text", text }] : []), ...images] });
      else if (text) messages.push({ role: m.role, content: text });
    }
  }

  const out: ChatCompletionRequest = { model: body.model, messages: messages as unknown as ChatCompletionRequest["messages"] };
  out.max_tokens = body.max_tokens;
  out.stream = body.stream;
  if (body.stream) out.stream_options = { include_usage: true };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: "object", properties: {} } },
    }));
    const tc = body.tool_choice;
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "none") out.tool_choice = "none";
    else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc) out.tool_choice = "auto";
  }
  return out;
}

const stopReasonOf = (finish?: string) =>
  finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn";

const parseArgs = (s: string | undefined) => {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
};

export function fromOpenAI(raw: string, model: string): string {
  const r = JSON.parse(raw);
  const choice = r.choices?.[0];
  const msg = choice?.message ?? {};
  const content: unknown[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return JSON.stringify({
    id: `msg_${r.id ?? Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReasonOf(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: r.usage?.prompt_tokens ?? 0,
      output_tokens: r.usage?.completion_tokens ?? 0,
    },
  });
}

export function anthropicError(status: number, upstream: string): string {
  let message = upstream;
  try { const j = JSON.parse(upstream); message = j.error?.message ?? j.message ?? upstream; } catch { /* keep raw text */ }
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error"
    : status >= 500 ? "api_error" : "invalid_request_error";
  return JSON.stringify({ type: "error", error: { type, message: String(message).slice(0, 2000) } });
}

// shortcut: ~4 chars/token estimate, swap for a real tokenizer if exact counts matter
export function estimateTokens(body: AnthropicRequest): number {
  return Math.ceil(JSON.stringify([body.system, body.messages, body.tools]).length / 4);
}

// Translate OpenAI SSE stream → Anthropic SSE stream
export async function pipeAsAnthropic(
  openAIStream: ReadableStream,
  model: string,
  write: (chunk: string) => void,
  end: () => void,
): Promise<void> {
  const send = (event: string, data: unknown) =>
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("message_start", {
    type: "message_start",
    message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  send("ping", { type: "ping" });

  let next = 0;                         // next anthropic block index
  let open: number | null = null;       // currently open block
  let textBlock: number | null = null;
  const toolBlocks = new Map<number, number>(); // openai tool index → anthropic block index
  const closeBlock = () => {
    if (open !== null) send("content_block_stop", { type: "content_block_stop", index: open });
    open = null;
  };

  const reader = openAIStream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finish: string | undefined;
  let usage = { input_tokens: 0, output_tokens: 0 };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; } // skip malformed chunks
        if (chunk.usage) {
          usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          if (textBlock === null || open !== textBlock) {
            closeBlock();
            textBlock = open = next++;
            send("content_block_start", { type: "content_block_start", index: textBlock,
              content_block: { type: "text", text: "" } });
          }
          send("content_block_delta", { type: "content_block_delta", index: textBlock,
            delta: { type: "text_delta", text: delta.content } });
        }
        for (const tc of delta?.tool_calls ?? []) {
          let idx = toolBlocks.get(tc.index ?? 0);
          if (idx === undefined) {
            closeBlock();
            idx = open = next++;
            toolBlocks.set(tc.index ?? 0, idx);
            send("content_block_start", { type: "content_block_start", index: idx,
              content_block: { type: "tool_use", id: tc.id ?? `toolu_${idx}`, name: tc.function?.name ?? "", input: {} } });
          }
          if (tc.function?.arguments) {
            send("content_block_delta", { type: "content_block_delta", index: idx,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
          }
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch (err) {
    send("error", { type: "error", error: { type: "api_error", message: (err as Error).message } });
    return end();
  }

  if (next === 0) { // empty reply: Anthropic clients expect at least one block
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    open = next++;
  }
  closeBlock();
  send("message_delta", { type: "message_delta",
    delta: { stop_reason: stopReasonOf(finish), stop_sequence: null },
    usage: { output_tokens: usage.output_tokens } });
  send("message_stop", { type: "message_stop" });
  end();
}
