// Typen zu prompt-limits.mjs (die API importiert die eine Quelle).
export type AgentRole = "planner" | "research" | "runner" | "safety" | "verifier";
export declare const PROMPT_LIMITS: Readonly<Record<AgentRole, number>>;
export declare function promptLimit(role: AgentRole): number;
export declare function promptLimitProblem(role: AgentRole, prompt: unknown): string | null;
