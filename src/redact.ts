const secretKeyPattern = /(?:api[_-]?key|authorization|bearer|token|secret|password|credential|private[_-]?key)/i
const secretValuePattern =
  /\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_\-]{8,}\b/g

const maxDepth = 5
const maxArray = 50

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > maxDepth) return "[Truncated]"
  if (typeof value === "string") return redactString(value)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => redactSecrets(item, depth + 1))
  if (typeof value !== "object") return value

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = secretKeyPattern.test(key) ? "[REDACTED]" : redactSecrets(item, depth + 1)
  }
  return out
}

export function redactString(value: string): string {
  return value.replace(secretValuePattern, "[REDACTED]")
}
