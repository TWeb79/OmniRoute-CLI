import type { Provider, RoutingConfig, ChatCompletionRequest } from "./types.js";

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
  // priority: already sorted ascending in loadConfig
  return providers;
}

function findProvider(providers: Provider[], model: string): Provider | undefined {
  // prefer a provider that explicitly lists this model, else first
  return providers.find((p) => p.models.includes(model)) ?? providers[0];
}

export async function proxyRequest(
  body: ChatCompletionRequest,
  providers: Provider[],
  routing: RoutingConfig,
): Promise<{ status: number; headers: Record<string, string>; body: ReadableStream | string }> {
  const ordered = pickProviders(providers, routing.strategy);
  const primary = findProvider(ordered, body.model);
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
