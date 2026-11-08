import Fastify from "fastify";
import cors from "@fastify/cors";
import type { Config, ChatCompletionRequest } from "./types.js";
import { proxyRequest } from "./proxy.js";

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
    const result = await proxyRequest(body, config.providers, config.routing);

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

  return app;
}
