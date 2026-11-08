import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Config, ChatCompletionRequest } from "./types.js";
import { proxyRequest } from "./proxy.js";
import { toOpenAI, fromOpenAI, pipeAsAnthropic } from "./anthropic-bridge.js";

export async function createServer(config: Config) {
  const app = Fastify({ logger: false });
  await app.register(cors);

  // optional bearer auth
  app.addHook("onRequest", async (req, reply) => {
    if (!config.auth.enabled) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token !== config.auth.api_key) {
      reply.status(401).send({ error: "Unauthorized" });
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
    return { object: "list", data };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const body = req.body as ChatCompletionRequest;
    const result = await proxyRequest(body, config.providers, config.routing, config.task_routing, config.model_map);

    for (const [k, v] of Object.entries(result.headers)) {
      reply.header(k, v);
    }
    reply.status(result.status);

    if (body.stream && result.body instanceof ReadableStream) {
      const reader = result.body.getReader();
      const stream = reply.raw;
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) { stream.end(); return; }
        stream.write(value);
        pump();
      };
      reply.hijack();
      pump();
      return reply;
    }

    return reply.send(result.body);
  });

  // Anthropic-format endpoint — used by Claude Code, the Anthropic SDK, etc.
  app.post("/v1/messages", async (req, reply) => {
    const anthropicBody = req.body as Parameters<typeof toOpenAI>[0];
    const openAIBody = toOpenAI(anthropicBody);
    const result = await proxyRequest(openAIBody, config.providers, config.routing, config.task_routing, config.model_map);

    if (anthropicBody.stream && result.body instanceof ReadableStream) {
      reply.header("content-type", "text/event-stream");
      reply.header("x-omniroute-provider", result.headers["x-omniroute-provider"] ?? "");
      reply.hijack();
      await pipeAsAnthropic(
        result.body,
        anthropicBody.model,
        (chunk) => reply.raw.write(chunk),
        () => reply.raw.end(),
      );
      return reply;
    }

    if (typeof result.body === "string" && result.status < 400) {
      return reply.status(200)
        .header("content-type", "application/json")
        .send(fromOpenAI(result.body, anthropicBody.model));
    }

    return reply.status(result.status).send(result.body);
  });

  return app;
}
