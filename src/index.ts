#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig, promptMissingKeys } from "./config.js";
import { createServer } from "./server.js";

const program = new Command();

program
  .name("omniroute-cli")
  .description("Lightweight OpenAI-compatible AI proxy — file-based config, no dashboard")
  .version("1.0.0");

program
  .command("start")
  .description("Start the proxy server")
  .option("-c, --config <path>", "Path to config file", "config.yml")
  .option("-p, --port <number>", "Override port from config")
  .option("--dry-run", "Validate config and exit without starting")
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig(opts.config);
    } catch (err) {
      console.error("Config error:", (err as Error).message);
      process.exit(1);
    }

    if (opts.port) config.port = parseInt(opts.port, 10);

    console.log(`\nomniroute-cli — ${config.providers.length} provider(s) loaded`);
    console.log(`  strategy : ${config.routing.strategy}`);
    console.log(`  fallback : ${config.routing.fallback}`);
    console.log(`  auth     : ${config.auth.enabled ? "enabled" : "disabled"}`);
    config.providers.forEach((p) =>
      console.log(`  provider : ${p.name} (priority ${p.priority}, ${p.models.length} model(s))`),
    );

    if (opts.dryRun) {
      const missing = config.providers.filter((p) => !p.api_key).map((p) => p.name);
      if (missing.length) console.log(`\nNote: no API key yet for: ${missing.join(", ")}`);
      console.log("\nDry run — config OK, exiting.");
      process.exit(0);
    }

    try {
      await promptMissingKeys(config);
    } catch (err) {
      console.error("API key error:", (err as Error).message);
      process.exit(1);
    }

    const server = await createServer(config);
    await server.listen({ port: config.port, host: config.host });
    console.log(`\nListening on http://${config.host}:${config.port}`);
    console.log("Endpoints: POST /v1/chat/completions  POST /v1/messages  GET /v1/models  GET /health\n");
  });

program.parse();
