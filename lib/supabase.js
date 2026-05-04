// lib/supabase.js — single shared admin client for the worker.
import { createClient } from "@supabase/supabase-js";

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[boot] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

/**
 * Insert into founder_alerts. Never throws — alert failures must not break the worker.
 */
export async function alert({ level = "info", source, title, body, context }) {
  try {
    const { error } = await supabase.from("founder_alerts").insert({
      level, source, title, body, context: context ?? null,
    });
    if (error) console.error("[alert] insert failed:", error.message);
  } catch (e) {
    console.error("[alert] threw:", e?.message || e);
  }
}

/**
 * Insert audit_log. Never throws.
 */
export async function audit({ task_id, agent_name, action, detail }) {
  try {
    const { error } = await supabase.from("audit_log").insert({
      task_id: task_id ?? null,
      agent_name: agent_name ?? null,
      action: action ?? null,
      detail: detail ?? null,
    });
    if (error) console.error("[audit] insert failed:", error.message);
  } catch (e) {
    console.error("[audit] threw:", e?.message || e);
  }
}
