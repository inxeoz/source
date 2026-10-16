#!/usr/bin/env bun
/**
 * Regenerate the prime agent's models.json with ONLY the opencode-go provider,
 * sourced from this repo's catalog (the model TOMLs under providers/opencode-go,
 * with base_model resolution against models/<lab>/<model>.toml) using the repo's
 * own loader (packages/core/src/generate.ts).
 *
 * The per-model mapping is a faithful port of the opencode-go branch of the
 * official prime catalog exporter
 * (PrimeIntellect-ai/prime-agent-catalog, exporter/generate-models.ts):
 *   - filters: tool_call !== true, status === "deprecated", type === "decision"
 *   - api/baseUrl from the effective npm (model-level provider.npm override,
 *     else the provider-level npm):
 *       @ai-sdk/openai        -> openai-responses,        <base>/v1
 *       @ai-sdk/anthropic     -> anthropic-messages,      <base>       (SDK appends /v1/messages)
 *       @ai-sdk/google        -> google-generative-ai,    <base>/v1
 *       @ai-sdk/alibaba       -> openai-completions,      <base>/v1 + {cacheControlFormat: "anthropic"}
 *       else/openai-compatible-> openai-completions,      <base>/v1
 *     with the known Go-endpoint fixups (minimax-m2.7, qwen* via anthropic npm,
 *     qwen3.5/3.6-plus thinkingFormat).
 *   - thinkingLevelMap: 1:1 from reasoning_options effort values ("none"->off),
 *     plus applyThinkingLevelMetadata() quirks (deepseek-v4, kimi-k3, gpt-5.6,
 *     gpt-6, anthropic off-drop, ...).
 *   - deepseek-v4 openai-completions entries get the deepseek thinking compat.
 *   - cost = base band only (input/output/cache_read/cache_write, USD/MTok).
 *
 * No static `headers` are emitted: the prime runtime injects
 * `x-opencode-session: <conversation-id>` + `User-Agent: prime-agent` itself
 * for opencode/opencode-go providers, and explicit model headers would
 * OVERRIDE that per-conversation session id (see prime-agent
 * crates/pa-ai/src/providers/opencode_headers.rs, push_opencode_headers).
 *
 * Usage (repo root or anywhere):
 *   bun scripts/gen-prime-models.ts                # git pull, then write
 *   bun scripts/gen-prime-models.ts --no-pull      # skip the pull
 *   bun scripts/gen-prime-models.ts --dry-run      # print JSON, write nothing
 *   bun scripts/gen-prime-models.ts --out FILE     # write FILE instead
 *
 * Output: <target> (default ~/.prime/agent/models.json, or $PRIME_MODELS_JSON)
 *   { "providers": { "opencode-go": { "models": [ ... ] } } }
 * The previous file, if any, is backed up next to it as
 * models.json.bak.<timestamp> before the atomic write.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateCatalog } from "../packages/core/src/generate.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PROVIDER = "opencode-go";
const BASE_PATH = "https://opencode.ai/zen/go";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const noPull = argv.includes("--no-pull");
const dryRun = argv.includes("--dry-run");
const outIdx = argv.indexOf("--out");
const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
const defaultOut = path.join(os.homedir(), ".prime", "agent", "models.json");
const target = outFile ?? process.env.PRIME_MODELS_JSON ?? defaultOut;

// ---------------------------------------------------------------------------
// 1. git pull
// ---------------------------------------------------------------------------

function pull(): void {
  if (noPull) {
    console.error("[gen-prime-models] skipping git pull (--no-pull)");
    return;
  }
  console.error("[gen-prime-models] git pull --ff-only");
  const child = Bun.spawnSync(["git", "pull", "--ff-only"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  if (child.exitCode !== 0) {
    console.error(
      `[gen-prime-models] git pull failed (exit ${child.exitCode}); not regenerating. ` +
        "Fix the local state (or pass --no-pull to use the current checkout).",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. Mapping (port of exporter/generate-models.ts, opencode-go branch)
// ---------------------------------------------------------------------------

type ThinkingLevelMap = Record<string, string | null>;

interface PrimeModelEntry {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  contextWindow?: number;
  maxTokens?: number;
}

const DEEPSEEK_V4_COMPAT = {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
};

const DEEPSEEK_V4_THINKING_LEVEL_MAP: ThinkingLevelMap = {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "max",
  max: null,
};

const KIMI_K3_THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: "max",
};

function mergeThinkingLevelMap(
  current: ThinkingLevelMap | undefined,
  patch: ThinkingLevelMap,
): ThinkingLevelMap {
  return { ...(current ?? {}), ...patch };
}

function supportsOpenAiXhigh(modelId: string): boolean {
  return (
    modelId.includes("gpt-5.2") ||
    modelId.includes("gpt-5.3") ||
    modelId.includes("gpt-5.4") ||
    modelId.includes("gpt-5.5") ||
    modelId.includes("gpt-5.6")
  );
}

function isGoogleThinkingApi(model: PrimeModelEntry): boolean {
  return model.api === "google-generative-ai" || model.api === "google-vertex";
}

function isGemini3ProModel(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

function isGemini3FlashModel(modelId: string): boolean {
  return /gemini-3(?:\.\d+)?-flash/.test(modelId.toLowerCase());
}

function isGemma4Model(modelId: string): boolean {
  return /gemma-?4/.test(modelId.toLowerCase());
}

/**
 * Per-family/known-model thinking-level fixes. Ported verbatim from
 * applyThinkingLevelMetadata() in exporter/generate-models.ts; the
 * provider-specific rules (openai, openai-codex) never match opencode-go
 * entries but are kept so the port stays in lockstep with upstream.
 */
function applyThinkingLevelMetadata(model: PrimeModelEntry): void {
  if (
    (model.api === "openai-responses" || model.api === "azure-openai-responses") &&
    model.id.startsWith("gpt-5")
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: null });
  }
  if (
    model.api === "openai-responses" &&
    model.provider === "openai" &&
    OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: "none" });
  }
  if (supportsOpenAiXhigh(model.id)) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { xhigh: "xhigh" });
  }
  if (model.id.includes("gpt-5.6")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      minimal: null,
      max: "max",
    });
  }
  // gpt-6: no minimal effort; xhigh/max are supported (OpenAI model pages).
  if (model.id.includes("gpt-6")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      minimal: null,
      xhigh: "xhigh",
      max: "max",
    });
  }
  if (
    (model.api === "openai-responses" ||
      model.api === "azure-openai-responses" ||
      model.api === "openai-codex-responses") &&
    model.id.includes("gpt-6-astra")
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: null });
  }
  // Per-family effort support per the Anthropic effort docs.
  if (
    model.id.includes("opus-4-6") ||
    model.id.includes("opus-4.6") ||
    model.id.includes("sonnet-4-6") ||
    model.id.includes("sonnet-4.6")
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { max: "max" });
  }
  if (
    model.id.includes("opus-4-7") ||
    model.id.includes("opus-4.8") ||
    model.id.includes("opus-4-8") ||
    model.id.includes("opus-5") ||
    model.id.includes("sonnet-5")
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      xhigh: "xhigh",
      max: "max",
    });
  }
  if (model.id.includes("fable-5") || model.id.includes("mythos-5")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      off: null,
      xhigh: "xhigh",
      max: "max",
    });
  }
  // Claude Opus 5.5 is always-on adaptive: it rejects disabled thinking.
  if (model.id.includes("opus-5-5") || model.id.includes("opus-5.5")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: null });
  }
  if (model.id.includes("mythos-preview")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: null, max: "max" });
  }
  if (model.api === "openai-completions" && model.id.includes("deepseek-v4")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(
      model.thinkingLevelMap,
      DEEPSEEK_V4_THINKING_LEVEL_MAP,
    );
  }
  const kimiK3Id = model.id.toLowerCase();
  if (
    !model.thinkingLevelMap &&
    (/^k3(-|$)/.test(kimiK3Id) || /(^|\/)kimi-k3(-|$)/.test(kimiK3Id))
  ) {
    model.thinkingLevelMap = mergeThinkingLevelMap(
      model.thinkingLevelMap,
      KIMI_K3_THINKING_LEVEL_MAP,
    );
  }
  if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      off: null,
      minimal: null,
      low: "LOW",
      medium: null,
      high: "HIGH",
    });
  }
  if (isGoogleThinkingApi(model) && isGemini3FlashModel(model.id)) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { off: null });
  }
  if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      off: null,
      minimal: "MINIMAL",
      low: null,
      medium: null,
      high: "HIGH",
    });
  }
  if (model.provider === "openai-codex" && supportsOpenAiXhigh(model.id) && !model.id.includes("gpt-5.6")) {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, { minimal: "low" });
  }
  if (model.provider === "openai-codex" && model.id === "gpt-5.1-codex-mini") {
    model.thinkingLevelMap = mergeThinkingLevelMap(model.thinkingLevelMap, {
      minimal: "medium",
      low: "medium",
      medium: "medium",
      high: "high",
    });
  }
  // models.dev reasoning_options list a model's effort levels, not whether it
  // accepts `thinking: {type: "disabled"}`, so the derived map hides "off" for
  // every Anthropic model. Only the always-on models reject disabled thinking;
  // drop the derived off override for the rest so "off" stays provider-default.
  if (
    model.api === "anthropic-messages" &&
    model.thinkingLevelMap?.off === null &&
    !model.id.includes("fable-5") &&
    !model.id.includes("mythos-5") &&
    !model.id.includes("mythos-preview") &&
    !model.id.includes("opus-5-5") &&
    !model.id.includes("opus-5.5")
  ) {
    delete model.thinkingLevelMap.off;
  }
}

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-sol",
  "gpt-6-luna",
]);

function getModelsDevInputModalities(m: any): string[] {
  if (!Array.isArray(m.modalities?.input) || m.modalities.input.length === 0) {
    return [];
  }
  return m.modalities.input.includes("image") ? ["text", "image"] : ["text"];
}

function getModelsDevCost(m: any): PrimeModelEntry["cost"] | undefined {
  if (m.cost === undefined || m.cost === null) return undefined;
  return {
    input: m.cost.input,
    output: m.cost.output,
    cacheRead: m.cost.cache_read ?? 0,
    cacheWrite: m.cost.cache_write ?? 0,
  };
}

function getModelsDevThinkingLevelMap(m: any): ThinkingLevelMap | undefined {
  const effortOption = m.reasoning_options?.find(
    (option: any) => option.type === "effort" && Array.isArray(option.values),
  );
  if (!effortOption) {
    return undefined;
  }

  const supportedValues = new Set<string>(effortOption.values);
  const map: ThinkingLevelMap = {};
  const setLevel = (level: string, upstreamValue: string): void => {
    map[level] = supportedValues.has(upstreamValue) ? upstreamValue : null;
  };

  map.off = supportedValues.has("none") ? "none" : supportedValues.has("off") ? "off" : null;
  setLevel("minimal", "minimal");
  setLevel("low", "low");
  setLevel("medium", "medium");
  setLevel("high", "high");
  setLevel("xhigh", "xhigh");
  setLevel("max", "max");
  return map;
}

function buildEntries(
  models: Record<string, any>,
  fallbackNpm: string | undefined,
): PrimeModelEntry[] {
  const entries: PrimeModelEntry[] = [];

  for (const [modelId, raw] of Object.entries(models)) {
    const m = raw as any;
    if (m.tool_call !== true) continue;
    if (m.status === "deprecated") continue;
    if ((m.type ?? "chat") === "decision") continue; // api.json default filter

    const npm = m.provider?.npm ?? fallbackNpm;
    let api: string;
    let baseUrl: string;
    let compat: Record<string, unknown> | undefined;

    if (npm === "@ai-sdk/openai") {
      api = "openai-responses";
      baseUrl = `${BASE_PATH}/v1`;
    } else if (npm === "@ai-sdk/anthropic") {
      api = "anthropic-messages";
      // Anthropic SDK appends /v1/messages to baseURL
      baseUrl = BASE_PATH;
    } else if (npm === "@ai-sdk/google") {
      api = "google-generative-ai";
      baseUrl = `${BASE_PATH}/v1`;
    } else if (npm === "@ai-sdk/alibaba") {
      api = "openai-completions";
      baseUrl = `${BASE_PATH}/v1`;
      compat = { cacheControlFormat: "anthropic" };
    } else {
      // null, undefined, or @ai-sdk/openai-compatible
      api = "openai-completions";
      baseUrl = `${BASE_PATH}/v1`;
    }

    // Fix known mismatches between models.dev npm data and actual
    // OpenCode Go endpoint behaviour. models.dev reports these models
    // as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
    // accept Anthropic SDK auth (MiniMax M2.7) or are served through the
    // OpenAI-compatible /v1/chat/completions path (Qwen routes).
    if (modelId === "minimax-m2.7" || (npm === "@ai-sdk/anthropic" && modelId.startsWith("qwen"))) {
      api = "openai-completions";
      baseUrl = `${BASE_PATH}/v1`;
    }
    if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
      api = "openai-completions";
      baseUrl = `${BASE_PATH}/v1`;
      // Qwen/DashScope uses enable_thinking at the top level.
      compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
    }

    const entry: PrimeModelEntry = {
      id: modelId,
      name: m.name || modelId,
      api,
      baseUrl,
      reasoning: m.reasoning === true,
      ...(getModelsDevThinkingLevelMap(m)
        ? { thinkingLevelMap: getModelsDevThinkingLevelMap(m) }
        : {}),
      input: getModelsDevInputModalities(m),
      ...(getModelsDevCost(m) ? { cost: getModelsDevCost(m) } : {}),
      ...(compat ? { compat } : {}),
      contextWindow: m.limit?.context,
      maxTokens: m.limit?.output,
    };
    // provider is used by the fixed-up rules above and dropped from output.
    (entry as any).provider = PROVIDER;
    entries.push(entry);
  }

  // Known-mismatch context fixes for the OpenCode variants (upstream).
  for (const candidate of entries) {
    if (
      (candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
    ) {
      candidate.contextWindow = 200000;
    }
    if (candidate.id === "gpt-5.4") {
      candidate.contextWindow = 272000;
      candidate.maxTokens = 128000;
    }
    if (
      (candidate.id === "claude-opus-4-6" ||
        candidate.id === "claude-sonnet-4-6" ||
        candidate.id === "claude-opus-4.6" ||
        candidate.id === "claude-sonnet-4.6")
    ) {
      candidate.contextWindow = 1000000;
    }
  }

  // DeepSeek V4 openai-completions entries: deepseek thinking compat + map.
  for (const candidate of entries) {
    if (candidate.api === "openai-completions" && candidate.id.includes("deepseek-v4")) {
      candidate.compat = { ...candidate.compat, ...DEEPSEEK_V4_COMPAT };
      candidate.thinkingLevelMap = mergeThinkingLevelMap(
        candidate.thinkingLevelMap,
        DEEPSEEK_V4_THINKING_LEVEL_MAP,
      );
    }
  }

  for (const entry of entries) {
    applyThinkingLevelMetadata(entry);
  }

  // Drop the internal provider field; the output shape has no `provider`.
  for (const entry of entries) {
    delete (entry as any).provider;
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

// ---------------------------------------------------------------------------
// 3. Load catalog + build
// ---------------------------------------------------------------------------

pull();

const { providers } = await generateCatalog(REPO_ROOT);
const provider = providers[PROVIDER];
if (!provider) {
  console.error(`[gen-prime-models] provider "${PROVIDER}" not found in the local catalog`);
  process.exit(1);
}

const models = buildEntries(provider.models, provider.npm);
if (models.length === 0) {
  console.error(`[gen-prime-models] no models produced for "${PROVIDER}"; refusing to write`);
  process.exit(1);
}

const output = JSON.stringify({ providers: { [PROVIDER]: { models } } }, null, 2) + "\n";

if (dryRun) {
  console.error(`[gen-prime-models] dry-run: ${models.length} models for ${PROVIDER}`);
  process.stdout.write(output);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Backup + atomic write
// ---------------------------------------------------------------------------

let previousIds: string[] = [];
if (existsSync(target)) {
  try {
    const old = JSON.parse(readFileSync(target, "utf8")) as any;
    previousIds = (old?.providers?.[PROVIDER]?.models ?? []).map(
      (m: any) => m?.id ?? "",
    );
  } catch {
    previousIds = [];
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const backup = `${target}.bak.${stamp}`;
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(target, backup);
  console.error(`[gen-prime-models] backed up previous file -> ${path.basename(backup)}`);
}

const tmp = `${target}.tmp`;
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(tmp, output);
renameSync(tmp, target);

const previousSet = new Set(previousIds);
const newSet = new Set(models.map((m) => m.id));
const added = models.map((m) => m.id).filter((id) => !previousSet.has(id));
const removed = previousIds.filter((id) => id && !newSet.has(id));

console.error(`[gen-prime-models] wrote ${target}`);
console.error(`[gen-prime-models] ${models.length} models for ${PROVIDER}`);
if (added.length > 0) console.error(`[gen-prime-models] added:   ${added.join(", ")}`);
if (removed.length > 0) console.error(`[gen-prime-models] removed: ${removed.join(", ")}`);
if (added.length === 0 && removed.length === 0) {
  console.error("[gen-prime-models] model set unchanged vs previous file");
}
