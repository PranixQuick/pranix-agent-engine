// lib/agents/debugging.js — debugging agent.
//
// Plans the right product-specific runtime audits. Read-only.

const AGENT = "debugging";

const PRODUCT_PROBES = {
  cart2save:  ["audit_api_failures", "audit_affiliate_health"],
  quickscanz: ["audit_api_failures", "audit_notifications"],
  quietkeep:  ["audit_api_failures", "audit_auth_flow"],
  vidyagrid:  ["audit_api_failures"],
  schoolos:   ["audit_api_failures", "audit_auth_flow"],
  pranix_site:["audit_api_failures"],
};

export async function plan(scope, ctx) {
  const plans = [];
  const products = await ctx.resolveProducts(scope);

  for (const p of products) {
    const probes = PRODUCT_PROBES[p] || ["audit_api_failures"];
    for (const action_name of probes) {
      plans.push({
        agent: AGENT,
        action_name,
        input: { product_name: p },
        requires_approval: false,
      });
    }
  }
  return plans;
}
