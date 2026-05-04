// lib/registry.js — project_registry reads + per-product credential resolution.
//
// Phase D-multi-account: each project_registry row carries the names of the
// env vars (github_token_env / vercel_token_env / supabase_key_env) the worker
// must use for that product. Adding a new account becomes a data change.

import { supabase } from "./supabase.js";

export async function getProject(name) {
  const { data, error } = await supabase
    .from("project_registry")
    .select("project_name, github_repo, vercel_project_id, supabase_project_id, url, account_tier, github_token_env, vercel_token_env, supabase_key_env")
    .eq("project_name", name)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data)  return { error: `project_registry: '${name}' not found` };
  return { project: data };
}

/**
 * Resolve the GitHub PAT for a given project_registry row.
 * Returns { token, env_name } or { error }.
 */
export function resolveGithubToken(project) {
  const envName = project?.github_token_env || "GITHUB_PAT";
  const tok = process.env[envName];
  if (!tok) return { error: `${envName} missing in worker env`, env_name: envName };
  return { token: tok, env_name: envName };
}

/**
 * Resolve the Vercel API token for a given project_registry row.
 */
export function resolveVercelToken(project) {
  const envName = project?.vercel_token_env || "VERCEL_TOKEN";
  const tok = process.env[envName];
  if (!tok) return { error: `${envName} missing in worker env`, env_name: envName };
  return { token: tok, env_name: envName };
}

/**
 * Resolve a per-product Supabase service-role key.
 * Falls back to legacy SUPABASE_*_SERVICE_ROLE_KEY by supabase id if the
 * registry row doesn't have supabase_key_env populated yet.
 */
export function resolveSupabaseKey(project) {
  const envName = project?.supabase_key_env;
  if (!envName) return { error: "no supabase_key_env in project_registry row", env_name: null };
  const key = process.env[envName];
  if (!key) return { error: `${envName} missing in worker env`, env_name: envName };
  return { token: key, env_name: envName };
}

/**
 * Resolve the optional Vercel team id for a given account_tier.
 * Primary → VERCEL_TEAM_ID
 * Secondary → VERCEL_SECONDARY_TEAM_ID
 */
export function resolveVercelTeamId(project) {
  const tier = project?.account_tier || "primary";
  if (tier === "secondary") return process.env.VERCEL_SECONDARY_TEAM_ID || null;
  return process.env.VERCEL_TEAM_ID || null;
}

export const PRODUCT_DEPLOY_MAP = {
  deploy_cart2save:  { project: "cart2save",  workflow: "deploy.yml" },
};
