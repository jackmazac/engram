/** Match DCP: skip tiny/internal runs that share the same system transform hook. */
export const INTERNAL_SYSTEM_MARKERS: readonly string[] = [
  "You are a title generator",
  "You are a helpful AI assistant tasked with summarizing conversations",
  "Summarize what was done in this conversation",
]

export function systemLooksInternal(body: string): boolean {
  return INTERNAL_SYSTEM_MARKERS.some((m) => body.includes(m))
}

/** Appended to the last `system[]` entry (same pattern as DCP system injection). */
export const ORCHESTRATOR_HINT_BLOCK = `<!-- Engram -->
<engram-hint>
Long-lived project context is in the \`memory\` tool — query it when planning, delegating, or revisiting past work on this repo (\`stats\` for a snapshot).
</engram-hint>`

export function appendOrchestratorHint(system: string[], block: string) {
  const pack = system.join("\n")
  if (pack.includes("<engram-hint>")) return
  if (system.length === 0) {
    system.push(block)
    return
  }
  const i = system.length - 1
  system[i] = system[i] + "\n\n" + block
}
