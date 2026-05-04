// lib/audit/findings.js — small helpers shared by audit agents.
//
// These produce *partial* finding objects ready to pass to ctx.find().
// They never write directly to DB; ctx.find() is the only path.

/**
 * Grade a number against thresholds. Returns one of: 'info' | 'warn' | 'error' | 'critical'.
 *
 * Example: grade(errorRate, { warn: 0.01, error: 0.05, critical: 0.20 })
 */
export function grade(value, { warn, error, critical }) {
  if (critical != null && value >= critical) return "critical";
  if (error    != null && value >= error)    return "error";
  if (warn     != null && value >= warn)     return "warn";
  return "info";
}

/**
 * Standard "missing required env var" finding.
 */
export function missingEnv(varName, productName) {
  return {
    severity: "error",
    category: "env",
    resource: varName,
    title:    `Required env var ${varName} is missing`,
    body:     `Worker handler cannot run: ${varName} is not set in the runtime environment for ${productName || "this project"}.`,
    evidence: { var: varName },
    remediation_action: null,
    remediation_input:  null,
  };
}

/**
 * Standard "external API call failed" finding (transient).
 */
export function apiFailure(category, resource, message, evidence) {
  return {
    severity: "error",
    category,
    resource,
    title:    `External API call failed: ${resource}`,
    body:     message,
    evidence: evidence ?? null,
  };
}

/**
 * Standard "deferred — needs founder action" finding (non-actionable by worker).
 */
export function deferred(category, productName, reason, hint) {
  return {
    severity: "warn",
    category,
    resource: productName,
    title:    `${productName}: audit deferred`,
    body:     `${reason}${hint ? ` — ${hint}` : ""}`,
    evidence: { product: productName, reason },
  };
}

/**
 * Healthy "all good" info finding — useful as a positive signal.
 */
export function healthy(category, resource, body) {
  return {
    severity: "info",
    category,
    resource,
    title:    `${resource}: healthy`,
    body:     body ?? null,
  };
}
