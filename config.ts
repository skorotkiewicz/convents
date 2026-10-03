export type Endpoint = { model: string; api_key_env?: string };
export type Participant = Endpoint & {
  name: string;
  base_url: string;
  role: string;
  extra_body?: Record<string, unknown>;
};
export type Config = {
  llms: Participant[];
  decision: Endpoint & { url: string; readiness_threshold: number };
  debate: { max_rounds: number; max_output_tokens: number; timeout_ms: number };
};

function table(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.trim();
}

function url(value: unknown, label: string): string {
  const result = text(value, label);
  const parsed = new URL(result);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
  return result;
}

function number(value: unknown, label: string, fallback: number, min: number, max: number, integer = true): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw new Error(`${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return result;
}

function endpoint(raw: Record<string, unknown>, label: string): Endpoint {
  return {
    model: text(raw.model, `${label}.model`),
    api_key_env: raw.api_key_env === undefined ? undefined : text(raw.api_key_env, `${label}.api_key_env`),
  };
}

export function apiKey(endpoint: Endpoint): string | undefined {
  if (!endpoint.api_key_env) return undefined;
  const key = process.env[endpoint.api_key_env];
  if (!key?.trim()) throw new Error(`Missing environment variable ${endpoint.api_key_env}`);
  return key;
}

export function parseConfig(source: string): Config {
  const raw = table(Bun.TOML.parse(source), "config");
  if (!Array.isArray(raw.llms) || raw.llms.length < 1 || raw.llms.length > 12) {
    throw new Error("Configure 1 to 12 [[llms]] entries");
  }
  const llms = raw.llms.map((value, i): Participant => {
    const label = `llms[${i}]`;
    const item = table(value, label);
    return {
      ...endpoint(item, label),
      name: text(item.name, `${label}.name`),
      base_url: url(item.base_url, `${label}.base_url`),
      role: item.role === undefined ? "Offer a practical solution and challenge weak assumptions." : text(item.role, `${label}.role`),
      extra_body: item.extra_body === undefined ? undefined : table(item.extra_body, `${label}.extra_body`),
    };
  });
  if (new Set(llms.map(llm => llm.name)).size !== llms.length) throw new Error("LLM names must be unique");
  const decision = table(raw.decision, "decision");
  const debate = table(raw.debate ?? {}, "debate");
  const config: Config = {
    llms,
    decision: {
      ...endpoint(decision, "decision"),
      url: url(decision.url, "decision.url"),
      readiness_threshold: number(decision.readiness_threshold, "decision.readiness_threshold", 0.8, 0, 1, false),
    },
    debate: {
      max_rounds: number(debate.max_rounds, "debate.max_rounds", 2, 2, 8),
      max_output_tokens: number(debate.max_output_tokens, "debate.max_output_tokens", 700, 32, 8192),
      timeout_ms: number(debate.timeout_ms, "debate.timeout_ms", 120000, 100, 600000),
    },
  };
  for (const endpoint of [...llms, config.decision]) apiKey(endpoint);
  return config;
}

export async function loadConfig(path = "config.toml"): Promise<Config> {
  return parseConfig(await Bun.file(path).text());
}
