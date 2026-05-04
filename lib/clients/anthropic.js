// lib/clients/anthropic.js — minimal Claude API wrapper for intent extraction.
//
// We do NOT depend on @anthropic-ai/sdk to keep the worker dependency surface
// tiny — the API is just HTTPS + JSON. Built-in fetch handles it.
//
// Required env: ANTHROPIC_API_KEY
// Optional env: ANTHROPIC_MODEL (default: claude-sonnet-4-6-20250929)

import { httpRequest } from "./http.js";

const API   = "https://api.anthropic.com";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6-20250929";

function authHeaders() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error("ANTHROPIC_API_KEY missing");
  return {
    "x-api-key":         k,
    "anthropic-version": "2023-06-01",
    "content-type":      "application/json",
  };
}

/**
 * Ask Claude to parse a founder command into a structured intent object.
 * Returns { ok, parsed, raw } on success, { ok:false, error, retryable } on failure.
 *
 * The prompt forces JSON-only output. We parse defensively.
 */
export async function parseIntent(commandText, knownProducts, knownIntents) {
  const system = [
    "You are an intent parser for the Pranix multi-agent system.",
    "You receive a founder command in natural language and return STRICT JSON.",
    "Never include prose, markdown, code fences, or commentary — JSON only.",
    "",
    "Schema:",
    "{",
    '  "intent": "<one of the known intents OR \"unknown\">",',
    '  "scope": { "products": ["<product_name>", ...] | "all" },',
    '  "confidence": <0..1>,',
    '  "reasoning": "<one short sentence>"',
    "}",
    "",
    `Known intents: ${JSON.stringify(knownIntents)}`,
    `Known products: ${JSON.stringify(knownProducts)}`,
    "",
    "Rules:",
    "- If the founder says 'all' or 'everything', set scope.products = \"all\".",
    "- If a product is named, use that exact slug from known products.",
    "- If neither intent nor scope can be inferred, use intent=\"unknown\" with scope.products=[].",
  ].join("\n");

  const r = await httpRequest(`${API}/v1/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: commandText }],
    }),
    timeoutMs: 20000,
  });

  if (!r.ok) {
    return {
      ok: false,
      retryable: !!r.retryable || r.status === 0 || r.status >= 500 || r.status === 429,
      status: r.status,
      error: r.data?.error?.message || r.text || `anthropic ${r.status}`,
    };
  }

  // Extract text from content blocks
  const blocks = Array.isArray(r.data?.content) ? r.data.content : [];
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("").trim();

  // Strip code fences if Claude added them despite instructions
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed = null;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    return { ok: false, retryable: false, error: `intent JSON parse failed: ${e.message}; got: ${cleaned.slice(0, 200)}` };
  }

  if (!parsed || typeof parsed !== "object" || !parsed.intent) {
    return { ok: false, retryable: false, error: "parsed intent missing required 'intent' field" };
  }

  return { ok: true, parsed, raw: text };
}
