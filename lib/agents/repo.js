// lib/agents/repo.js — repo agent.
//
// Read-only: audit_repo per product. Mutating actions (workflow_dispatch)
// are NOT planned proactively; only when a fix is explicitly requested.

const AGENT = "repo";

export async function plan(scope, ctx) {
  const plans = [];
  const products = await ctx.resolveProducts(scope);

  for (const p of products) {
    plans.push({
      agent: AGENT,
      action_name: "audit_repo",
      input: { product_name: p },
      requires_approval: false,
    });
  }
  return plans;
}
