import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyReply } from "fastify";
import type { Config, ChatCompletionRequest } from "./types.js";
import { proxyRequest } from "./proxy.js";
import { toOpenAI, fromOpenAI, pipeAsAnthropic, anthropicError, estimateTokens } from "./anthropic-bridge.js";

// Send headers ourselves (hijack skips Fastify's) and write the stream with backpressure.
function startStream(reply: FastifyReply, status: number, headers: Record<string, string>) {
  reply.hijack();
  const raw = reply.raw;
  let closed = false;
  raw.on("close", () => { closed = true; });
  raw.writeHead(status, {
    ...headers,
    "access-control-allow-origin": "*", // hijack bypasses the CORS plugin's reply hooks
  });
  return {
    raw,
    write: (chunk: string | Uint8Array) => { if (!closed) raw.write(chunk); },
    end: () => { if (!closed) raw.end(); },
  };
}

export async function createServer(config: Config) {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
  await app.register(cors);

  // optional auth: Bearer (OpenAI clients) or x-api-key (Anthropic clients)
  app.addHook("onRequest", async (req, reply) => {
    if (!config.auth.enabled || req.method === "OPTIONS" || req.url === "/health") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
    if (token !== config.auth.api_key) {
      return reply.status(401).send({ error: { message: "Unauthorized" } });
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/models", async () => {
    const seen = new Set<string>();
    const data = config.providers.flatMap((p) =>
      p.models
        .filter((m) => !seen.has(m) && seen.add(m))
        .map((m) => ({ id: m, object: "model", owned_by: p.name })),
    );
    for (const alias of Object.keys(config.model_map ?? {})) {
      if (!seen.has(alias)) data.push({ id: alias, object: "model", owned_by: "model_map" });
    }
    return { object: "list", data };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as ChatCompletionRequest;
    if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      return reply.status(400).send({ error: { message: "`model` and `messages` are required" } });
    }
    const result = await proxyRequest(body, config.providers, config.routing, config.task_routing, config.model_map);

    if (body.stream && result.body instanceof ReadableStream) {
      const out = startStream(reply, result.status, result.headers);
      const reader = result.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(value);
        }
      } catch (err) {
        console.error("[omniroute-cli] stream error:", (err as Error).message);
      }
      out.end();
      return reply;
    }

    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    return reply.status(result.status).send(result.body);
  });

  // Anthropic-format endpoint — used by Claude Code, the Anthropic SDK, etc.
  app.post("/v1/messages", async (req, reply) => {
    const anthropicBody = req.body as Parameters<typeof toOpenAI>[0];
    if (!anthropicBody || typeof anthropicBody.model !== "string" || !Array.isArray(anthropicBody.messages)) {
      return reply.status(400).header("content-type", "application/json").send(
        anthropicError(400, "`model` and `messages` are required"));
    }
    const result = await proxyRequest(
      toOpenAI(anthropicBody), config.providers, config.routing, config.task_routing, config.model_map);

    if (anthropicBody.stream && result.body instanceof ReadableStream) {
      const out = startStream(reply, 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-omniroute-provider": result.headers["x-omniroute-provider"] ?? "",
      });
      await pipeAsAnthropic(result.body, anthropicBody.model, out.write, out.end);
      return reply;
    }

    reply.header("content-type", "application/json");
    if (typeof result.body === "string" && result.status < 400) {
      try {
        return reply.status(200).send(fromOpenAI(result.body, anthropicBody.model));
      } catch {
        return reply.status(502).send(anthropicError(502, "Upstream returned invalid JSON"));
      }
    }
    return reply.status(result.status).send(anthropicError(result.status, String(result.body)));
  });

  // Claude Code calls this for context accounting
  app.post("/v1/messages/count_tokens", async (req) => ({
    input_tokens: estimateTokens(req.body as Parameters<typeof estimateTokens>[0]),
  }));

  return app;
}
