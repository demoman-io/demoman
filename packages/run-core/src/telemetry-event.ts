export interface TelemetryEvent {
  id: string;
  producer: "replay" | "badge";
  kind: string;
  sceneId: string | null;
  /** ISO 8601. The store has no clock; callers pass one. */
  at: string;
  data: Record<string, number | boolean | string>;
}
