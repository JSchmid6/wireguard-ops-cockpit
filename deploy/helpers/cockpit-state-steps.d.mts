// Typen zu cockpit-state-steps.mjs (die API importiert die eine Quelle).
export type StateStepKind = "package" | "gitlab" | "migration" | "compose" | "update-helper" | "switch" | "disk";
export interface StepUninterruptible {
  uninterruptible: boolean;
  kinds: StateStepKind[];
  // Paketverwaltung: nach einem Fehler räumt der Helfer dpkg auf und prüft die Dienste.
  packageStep: boolean;
  // detected:<kind>, planner, mutating-run
  reasons: string[];
}
export declare const STATE_STEPS_VERSION: "cockpit-state-steps/v1";
export declare function stateStepKinds(text: string): StateStepKind[];
export declare function stepUninterruptible(
  manifest: { mutates?: boolean },
  step: { name?: string; run?: string; uninterruptible?: boolean },
): StepUninterruptible;
