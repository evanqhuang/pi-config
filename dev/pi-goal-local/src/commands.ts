export type GoalCommand =
  | { kind: "start"; objective: string; criteria: string[] }
  | { kind: "status" | "pause" | "resume" | "stop" | "clear" };

export function parseGoalCommand(raw: string | undefined): GoalCommand {
  const value = (raw ?? "").trim();
  if (!value || value === "status") return { kind: "status" };
  if (value === "pause" || value === "resume" || value === "stop" || value === "clear") {
    return { kind: value };
  }

  const separator = value.indexOf(" -- ");
  if (separator < 0) return { kind: "start", objective: value, criteria: [] };
  const objective = value.slice(0, separator).trim();
  const criteriaText = value.slice(separator + 4).trim();
  if (!objective) throw new Error("Goal objective cannot be empty.");
  const criteria = criteriaText
    ? criteriaText.split(/\s*;\s*|\s*\n\s*/).map(v => v.trim()).filter(Boolean)
    : [];
  return { kind: "start", objective, criteria };
}

export function formatGoalStatus(state: {
  status: string;
  objective: string;
  iteration: number;
  lastReason?: string;
} | undefined): string {
  if (!state) return "No native goal is set on this session branch.";
  return `${state.status.toUpperCase()}: ${state.objective} (iteration ${state.iteration})${state.lastReason ? ` — ${state.lastReason}` : ""}`;
}
