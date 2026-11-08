import type { Provider, RoutingConfig, TaskRule, ChatCompletionRequest } from "./types.js";

let rrIndex = 0;

function pickProviders(providers: Provider[], strategy: RoutingConfig["strategy"]): Provider[] {
  if (strategy === "round-robin") {
    const start = rrIndex % providers.length;
    rrIndex++;
    return [...providers.slice(start), ...providers.slice(0, start)];
  }
  if (strategy === "random") {
    const a = [...providers]; // Fisher-Yates
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  return providers;
}

function lastUserText(messages: ChatCompletionRequest["messages"]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return (typeof last.content === "string" ? last.content : JSON.stringify(last.content)).toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function detectTask(
  messages: ChatCompletionRequest["messages"],
  rules: Record<string, TaskRule>,
): TaskRule | undefined {
  const text = lastUserText(messages);
  for (const rule of Object.values(rules)) {
    // whole-word match so "api" doesn't hit "capital"
    if (rule.keywords.some((kw) => new RegExp(`\\b${escapeRe(kw.toLowerCase())}\\b`).test(text))) return rule;
  }
}

export type ProxyResult = {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream | string;
};

export async function proxyRequest(
  body: ChatCompletionRequest,
  providers: Provider[],
  routing: RoutingConfig,
  taskRouting?: Record<string, TaskRule>,
  modelMap?: Record<string, string>,
): Promise<ProxyResult> {
  // remap model name (e.g. claude-opus-5-5 → nvidia/nemotron-3-ultra-550b-a55b)
  if (modelMap) {
    const mapped = modelMap[body.model] ??
      Object.entries(modelMap).find(([k]) => body.model.startsWith(k))?.[1];
    if (mapped) {
      console.log(`[omniroute-cli] model map: ${body.model} → ${mapped}`);
      body = { ...body, model: mapped };
    }
  }

  // task routing: a matching rule overrides the requested model
  const task = taskRouting ? detectTask(body.messages, taskRouting) : undefined;
  if (task) {
    console.log(`[omniroute-cli] task matched → model: ${task.preferred_model}`);
    body = { ...body, model: task.preferred_model };
  }

  // only providers that serve the model; if none list it, pass it through to all
  const ordered = pickProviders(providers, routing.strategy);
  const serving = ordered.filter((p) => p.models.includes(body.model));
  const candidates = serving.length ? serving : ordered;
  const tryList = routing.fallback ? candidates : candidates.slice(0, 1);

  let lastStatus = 502;
  let lastBody = JSON.stringify({ error: { message: "No providers available" } });

  for (const provider of tryList) {
    const url = `${provider.base_url.replace(/\/$/, "")}/chat/completions`;
    let res: Response;
    // timeout covers connect + response headers only; cleared so long streams aren't cut
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.api_key}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      lastStatus = 502;
      lastBody = JSON.stringify({ error: { message: `${provider.name}: ${(err as Error).message}` } });
      console.error(`[omniroute-cli] provider ${provider.name} unreachable: ${(err as Error).message}`);
      continue;
    }

    if (res.ok || !routing.fallback) {
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        // fetch already decoded the body, so encoding/length headers would be wrong
        if (!["transfer-encoding", "connection", "content-encoding", "content-length"].includes(k)) headers[k] = v;
      });
      headers["x-omniroute-provider"] = provider.name;
      console.log(`[omniroute-cli] → ${provider.name} / ${body.model}`);
      return {
        status: res.status,
        headers,
        body: body.stream && res.ok ? (res.body as ReadableStream) : await res.text(),
      };
    }

    lastStatus = res.status;
    lastBody = await res.text();
    console.error(`[omniroute-cli] provider ${provider.name} returned ${res.status}, trying next`);
  }

  return { status: lastStatus, headers: { "content-type": "application/json" }, body: lastBody };
}
