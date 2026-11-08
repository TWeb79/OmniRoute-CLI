import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../dist/server.js";

// fake OpenAI-style upstream
const up = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const j = JSON.parse(b);
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ls", arguments: "{\"a\":" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", model: j.model, choices: [{ message: { content: "hi" }, finish_reason: "stop" }], echo: j }));
  });
});

test("gateway", async () => {
  await new Promise((r) => up.listen(0, r));
  const base = `http://127.0.0.1:${up.address().port}/v1`;
  const mk = (name, models, priority) => ({ name, api_key: "k", base_url: name === "dead" ? "http://127.0.0.1:1/v1" : base, models, priority });
  const app = await createServer({
    port: 0, host: "127.0.0.1",
    providers: [mk("dead", ["m1"], 1), mk("live", ["m1"], 2)],
    routing: { strategy: "priority", fallback: true },
    task_routing: { coding: { keywords: ["api"], preferred_model: "m1" } },
    model_map: { claude: "m1" },
    auth: { enabled: true, api_key: "secret" },
  });

  assert.equal((await app.inject({ method: "POST", url: "/v1/messages", payload: {} })).statusCode, 401);
  const h = { "x-api-key": "secret" };

  // falls back past dead provider; anthropic shape; tool_result mapped
  const r = await app.inject({ method: "POST", url: "/v1/messages", headers: h, payload: {
    model: "claude-x", max_tokens: 5, temperature: 0.3,
    tools: [{ name: "ls", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "capital" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ls", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] } });
  const j = r.json();
  assert.equal(j.content[0].text, "hi");
  assert.equal(r.headers["x-omniroute-provider"], undefined); // not leaked onto json body path is fine either way
  assert.equal(r.statusCode, 200);

  // streaming tool call
  const s = await app.inject({ method: "POST", url: "/v1/messages", headers: h, payload: {
    model: "claude-x", max_tokens: 5, stream: true, messages: [{ role: "user", content: "hello" }] } });
  assert.match(s.body, /"type":"tool_use"/);
  assert.match(s.body, /input_json_delta/);
  assert.match(s.body, /"stop_reason":"tool_use"/);

  assert.equal((await app.inject({ method: "POST", url: "/v1/chat/completions", headers: h, payload: {} })).statusCode, 400);
  await app.close(); up.close();
});
