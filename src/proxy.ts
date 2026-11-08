import type { Provider, RoutingConfig, TaskRule, ChatCompletionRequest } from "./types.js";

let rrIndex = 0;

function pickProviders(providers: Provider[], strategy: RoutingConfig["strategy"]): Provider[] {
  if (strategy === "round-robin") {
    const start = rrIndex % providers.length;
    rrIndex++;
    return [...providers.slice(start), ...providers.slice(0, start)];
  }
  if (strategy === "random") {
    return [...providers].sort(() => Math.random() - 0.5);
  }
  return providers;
}

function findProvider(providers: Provider[], model: string): Provider | undefined {
  return providers.find((p) => p.models.includes(model)) ?? providers[0];
}

function detectTask(
  messages: ChatCompletionRequest["messages"],
  rules: Record<string, TaskRule>,
): TaskRule | undefined {
  // scan last user message for keyword matches
  const text = messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ")
    .toLowerCase();
  for (const rule of Object.values(rules)) {
    if (rule.keywords.some((kw) => text.includes(kw.toLowerCase()))) return rule;
  }
}

export async function proxyRequest(
  body: ChatCompletionRequest,
  providers: Provider[],
  routing: RoutingConfig,
  taskRouting?: Record<string, TaskRule>,
): Promise<{ status: number; headers: Record<string, string>; body: ReadableStream | string }> {
  const ordered = pickProviders(providers, routing.strategy);

  // task routing: if a rule matches, promote that model's provider to front
  const task = taskRouting ? detectTask(body.messages, taskRouting) : undefined;
  const preferredModel = task?.preferred_model ?? body.model;
  const primary = findProvider(ordered, preferredModel);
  if (task) console.log(`[omniroute-cli] task matched → preferred model: ${preferredModel}`);

  const candidates = primary
    ? [primary, ...ordered.filter((p) => p !== primary)]
    : ordered;

  const tryList = routing.fallback ? candidates : candidates.slice(0, 1);

  let lastStatus = 500;
  let lastBody = "No providers available";

  for (const provider of tryList) {
    const url = `${provider.base_url.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (res.ok || !routing.fallback) {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!["transfer-encoding", "connection"].includes(k)) headers[k] = v;
      });
      headers["x-omniroute-provider"] = provider.name;
      return {
        status: res.status,
        headers,
        body: body.stream ? (res.body as ReadableStream) : await res.text(),
      };
    }

    lastStatus = res.status;
    lastBody = await res.text();
    console.error(`[omniroute-cli] provider ${provider.name} returned ${res.status}, trying next`);
  }

  return { status: lastStatus, headers: { "content-type": "application/json" }, body: lastBody };
}
