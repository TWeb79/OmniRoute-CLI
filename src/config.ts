import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { Config } from "./types.js";

const ProviderSchema = z.object({
  name: z.string(),
  api_key: z.string(),
  base_url: z.string().url(),
  models: z.array(z.string()).default([]),
  priority: z.number().int().default(1),
});

const TaskRuleSchema = z.object({
  keywords: z.array(z.string()),
  preferred_model: z.string(),
});

const ConfigSchema = z.object({
  port: z.number().int().default(20128),
  providers: z.array(ProviderSchema).min(1, "At least one provider required"),
  routing: z.object({
    strategy: z.enum(["priority", "round-robin", "random"]).default("priority"),
    fallback: z.boolean().default(true),
  }).default({}),
  task_routing: z.record(TaskRuleSchema).optional(),
  model_map: z.record(z.string()).optional(),
  auth: z.object({
    enabled: z.boolean().default(false),
    api_key: z.string().optional(),
  }).default({}),
});

function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] ?? "");
}

function interpolateProviderKeys(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  if (Array.isArray(raw)) return raw.map(interpolateProviderKeys);
  const obj = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === "string" ? interpolateEnv(v) : interpolateProviderKeys(v);
  }
  return result;
}

export function loadConfig(configPath: string): Config {
  const abs = resolve(configPath);
  const raw = yaml.load(readFileSync(abs, "utf8"));
  const interpolated = interpolateProviderKeys(raw);
  const parsed = ConfigSchema.parse(interpolated);
  // sort providers by priority ascending so index 0 = highest priority
  parsed.providers.sort((a, b) => a.priority - b.priority);
  return parsed as Config;
}
