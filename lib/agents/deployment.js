// lib/agents/deployment.js — deployment agent.
//
// Read-only audit by default. Schedules a redeploy ONLY when intent === 'redeploy_product'
// and a single product is named — never fans out a redeploy across all products.

const AGENT = "deployment";

export async function plan(scope, ctx) {
  const plans = [];
  const products = await ctx.resolveProducts(scope);

  if (scope.intent === "redeploy_product") {
    if (products.length !== 1) {
      // Refuse to plan — never auto-redeploy "all"
      return plans;
    }
    plans.push({
      agent: AGENT,
      action_name: "vercel_redeploy",
      input: { project_name: products[0] },
      requires_approval: true,
    });
    return plans;
  }

  // Default: audit only
  for (const p of products) {
    plans.push({
      agent: AGENT,
      action_name: "audit_deployments",
      input: { product_name: p },
      requires_approval: false,
    });
  }
  return plans;
}
