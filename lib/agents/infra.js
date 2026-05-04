// lib/agents/infra.js — infra agent.
//
// Plans: env audits, schema audits, engine self-test, full-product fan-out.
// Owns nothing destructive on its own.
//
// Contract: every agent exports plan(scope, ctx) → Array<PlannedAction>
// Where PlannedAction = { agent, action_name, input, requires_approval }

const AGENT = "infra";

export async function plan(scope, ctx) {
  const plans = [];
  const products = await ctx.resolveProducts(scope);

  // Always include a self-test on 'audit_all' so we know the engine itself is healthy
  if (scope.intent === "audit_all" || scope.intent === "check_health") {
    plans.push({
      agent: AGENT,
      action_name: "worker_self_test",
      input: { from: "infra_agent" },
      requires_approval: false,
    });
  }
  if (scope.intent === "check_health") return plans;

  for (const p of products) {
    plans.push({ agent: AGENT, action_name: "audit_env_vars",     input: { product_name: p }, requires_approval: false });
    plans.push({ agent: AGENT, action_name: "audit_schema_drift", input: { product_name: p }, requires_approval: false });
  }
  return plans;
}
