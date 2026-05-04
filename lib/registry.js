// lib/registry.js — fetches project_registry rows used by the orchestrator.
import { supabase } from "./supabase.js";

export async function getProject(name) {
  const { data, error } = await supabase
    .from("project_registry")
    .select("project_name, github_repo, vercel_project_id, supabase_project_id, url")
    .eq("project_name", name)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data)  return { error: `project_registry: '${name}' not found` };
  return { project: data };
}

/**
 * Resolve a product action to its project_registry row + a default workflow file.
 * The mapping is intentionally explicit so handlers don't guess.
 */
export const PRODUCT_DEPLOY_MAP = {
  // action_name -> { project: project_registry.project_name, workflow: file in .github/workflows/ }
  deploy_cart2save:  { project: "cart2save",  workflow: "deploy.yml" },
};
