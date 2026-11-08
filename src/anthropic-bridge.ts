// Translates Anthropic /v1/messages ↔ OpenAI /v1/chat/completions

import type { ChatCompletionRequest } from "./types.js";

interface AnthropicContentBlock { type: string; text?: string }
interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: { role: string; content: string | AnthropicContentBlock[] }[];
  system?: string | AnthropicContentBlock[];
  stream?: boolean;
  [key: string]: unknown;
}

function systemText(s: string | AnthropicContentBlock[]): string {
  if (typeof s === "string") return s;
  return s.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

function messageText(c: string | AnthropicContentBlock[]): string {
  if (typeof c === "string") return c;
  return c.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

export function toOpenAI(body: AnthropicRequest): ChatCompletionRequest {
  const messages: { role: string; content: string }[] = [];
  if (body.system) messages.push({ role: "system", content: systemText(body.system) });
  for (const m of body.messages) {
    messages.push({ role: m.role, content: messageText(m.content) });
  }
  return { model: body.model, messages, max_tokens: body.max_tokens, stream: body.stream };
}

export function fromOpenAI(raw: string, model: string): string {
  const r = JSON.parse(raw);
  const choice = r.choices?.[0];
  const text = choice?.message?.content ?? "";
  const stopReason = choice?.finish_reason === "length" ? "max_tokens" : "end_turn";
  return JSON.stringify({
    id: `msg_${r.id ?? Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: r.usage?.prompt_tokens ?? 0,
      output_tokens: r.usage?.completion_tokens ?? 0,
    },
  });
}

// Translate OpenAI SSE stream → Anthropic SSE stream (passthrough writer to raw socket)
export async function pipeAsAnthropic(
  openAIStream: ReadableStream,
  model: string,
  write: (chunk: string) => void,
  end: () => void,
): Promise<void> {
  const msgId = `msg_${Date.now()}`;
  const send = (event: string, data: unknown) =>
    write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", content: [], model,
      stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  send("content_block_start", { type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" } });
  send("ping", { type: "ping" });

  const reader = openAIStream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let stopReason = "end_turn";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        const finish = chunk.choices?.[0]?.finish_reason;
        if (delta) {
          send("content_block_delta", { type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: delta } });
        }
        if (finish === "length") stopReason = "max_tokens";
      } catch { /* skip malformed chunks */ }
    }
  }

  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 } });
  send("message_stop", { type: "message_stop" });
  end();
}
