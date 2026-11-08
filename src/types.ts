export interface Provider {
  name: string;
  api_key: string;
  base_url: string;
  models: string[];
  priority: number;
}

export interface RoutingConfig {
  strategy: "priority" | "round-robin" | "random";
  fallback: boolean;
}

export interface TaskRule {
  keywords: string[];
  preferred_model: string;
}

export interface AuthConfig {
  enabled: boolean;
  api_key?: string;
}

export interface Config {
  port: number;
  providers: Provider[];
  routing: RoutingConfig;
  task_routing?: Record<string, TaskRule>;
  auth: AuthConfig;
}

export interface OpenAIMessage {
  role: string;
  content: string | unknown[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  [key: string]: unknown;
}
