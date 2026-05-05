const progressBarPattern = /[█▇▆▅▄▃▂▁⣿]{6,}/;

export function isLowValueMemoryText(text: string, agent: string | null | undefined): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return (
    isDcpCompressionBanner(trimmed) ||
    isSubagentAssignmentBanner(trimmed, agent) ||
    isProgressOnlyText(trimmed)
  );
}

function isDcpCompressionBanner(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("▣ dcp") ||
    (lower.includes("compression #") && lower.includes("removed") && lower.includes("summary"))
  );
}

function isSubagentAssignmentBanner(text: string, agent: string | null | undefined): boolean {
  const lower = text.toLowerCase();
  const agentName = (agent ?? "").toLowerCase();
  return (
    agentName.includes("executor") &&
    lower.startsWith("plan:") &&
    lower.includes(" | task:") &&
    lower.includes(" | wave:") &&
    lower.includes("first load plan")
  );
}

function isProgressOnlyText(text: string): boolean {
  return progressBarPattern.test(text) && text.length < 600;
}
