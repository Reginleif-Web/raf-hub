// Settings of the factory link, set by the owner. Nothing here has a default that turns the link on:
// with no URL and no hub token the hub behaves exactly as it did before the link existed.
// Secrets (the two API tokens and the button keys) come only from the environment or the state-dir .env,
// never from config.json and never from the repository; config.json `factory` holds the non-secret numbers
// and the gate command.
import { paths, readText } from "../shared/config.ts";
import { arr, field, isObject, str } from "../shared/guards.ts";

export const FACTORY_ENV = {
  url: "TELEGRAM_HUB_FACTORY_URL",
  hubToken: "TELEGRAM_HUB_FACTORY_HUB_TOKEN",
  relayToken: "TELEGRAM_HUB_FACTORY_RELAY_TOKEN",
  buttonKeys: "TELEGRAM_HUB_BUTTON_KEYS",
} as const;

// api.md `hub.pollAnswerIntervalMs`, `registry.gateTimeoutMs`: the spec leaves the numbers to the deployment,
// these are the defaults of a hub that has no value set.
export const DEFAULT_POLL_ANSWER_INTERVAL_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_REGISTRY_TIMEOUT_MS = 3_000;
export const DEFAULT_GATE_TIMEOUT_MS = 3_000;
// A button works for a while, then it is refused; the client that sent it may choose a different window per its own rules.
export const DEFAULT_PRESS_WINDOW_MS = 10 * 60_000;

export type FactoryApiSettings = {
  url: string;
  hubToken: string;
  // Role L: poll registration. Without it polls are sent unregistered.
  relayToken?: string;
  pollAnswerIntervalMs: number;
  requestTimeoutMs: number;
  registryTimeoutMs: number;
};

export type FactoryGateSettings = {
  // argv; `{session_id}` and `{tool_use_id}` in any element are replaced before the run.
  command: string[];
  timeoutMs: number;
};

export type FactoryButtonSettings = {
  // client name -> its key. A key opens the button endpoints for that client only.
  keys: Record<string, string>;
  pressWindowMs: number;
};

export type FactorySettings = {
  api?: FactoryApiSettings;
  gate?: FactoryGateSettings;
  buttons?: FactoryButtonSettings;
};

type Env = Record<string, string | undefined>;

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

// "name=key,name=key"; a malformed pair is skipped, never half-read.
export function parseButtonKeys(text: string | undefined): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const key = pair.slice(at + 1).trim();
    if (name && key) keys[name] = key;
  }
  return keys;
}

// `raw` is the `factory` object of config.json (any value); undefined when nothing is configured.
export function parseFactorySettings(raw: unknown, env: Env): FactorySettings | undefined {
  const settings: FactorySettings = {};
  const url = env[FACTORY_ENV.url]?.trim();
  const hubToken = env[FACTORY_ENV.hubToken]?.trim();
  if (url && hubToken) {
    settings.api = {
      url: url.replace(/\/+$/, ""),
      hubToken,
      relayToken: env[FACTORY_ENV.relayToken]?.trim() || undefined,
      pollAnswerIntervalMs: positive(field(raw, "pollAnswerIntervalMs"), DEFAULT_POLL_ANSWER_INTERVAL_MS),
      requestTimeoutMs: positive(field(raw, "requestTimeoutMs"), DEFAULT_REQUEST_TIMEOUT_MS),
      registryTimeoutMs: positive(field(raw, "registryTimeoutMs"), DEFAULT_REGISTRY_TIMEOUT_MS),
    };
  }
  const gate = field(raw, "gate");
  const command = arr(field(gate, "command")).filter((part): part is string => typeof part === "string" && part !== "");
  if (isObject(gate) && command.length) settings.gate = { command, timeoutMs: positive(field(gate, "timeoutMs"), DEFAULT_GATE_TIMEOUT_MS) };
  const keys = parseButtonKeys(env[FACTORY_ENV.buttonKeys]);
  if (Object.keys(keys).length) settings.buttons = { keys, pressWindowMs: positive(field(raw, "pressWindowMs"), DEFAULT_PRESS_WINDOW_MS) };
  return settings.api || settings.gate || settings.buttons ? settings : undefined;
}

// The state-dir .env lines `NAME=value`, the same file the bot token lives in.
function envFileValues(): Env {
  const values: Env = {};
  try {
    for (const line of readText(paths().envFile).split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match?.[1] && match[2]) values[match[1]] = match[2];
    }
  } catch {}
  return values;
}

export function loadFactorySettings(): FactorySettings | undefined {
  let raw: unknown;
  try { raw = field(JSON.parse(readText(paths().configFile)), "factory"); } catch {}
  const file = envFileValues();
  const env: Env = {};
  for (const name of Object.values(FACTORY_ENV)) env[name] = str(process.env[name]) || file[name];
  return parseFactorySettings(raw, env);
}
