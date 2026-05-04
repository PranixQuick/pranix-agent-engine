// lib/agents/compliance.js — compliance agent.
//
// Reuses audit_repo (which already covers dependabot + LICENSE + secret-pattern repo scan).
// In future this would add: Supabase advisor probe, license inventory, terms posture.

const AGENT = "compliance";

export async function plan(scope, ctx) {
  const plans = [];
  const products = await ctx.resolveProducts(scope);

  // Use audit_repo's compliance dimensions; we tag the agent as 'compliance' in the
  // command_invocations log so the dashboard groups it correctly even though the
  // underlying handler is shared.
  for (const p of products) {
    plans.push({
      agent: AGENT,
      action_name: "audit_repo",
      input: { product_name: p, _agent_tag: "compliance" },
      requires_approval: false,
    });
  }
  return plans;
}
