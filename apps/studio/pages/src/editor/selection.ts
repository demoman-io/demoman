import type { SourcePoint } from "@demoman/scene-schema";

/** What the author has picked: a step's tick, a zoom segment, a mask segment, or nothing. */
export type Selection =
  | { kind: "tick"; actionId: string }
  | { kind: "zoom"; id: string }
  | { kind: "mask"; id: string }
  /** A piece of the clip, by the frame it starts at (null: the take's
   *  start). Not by output position: a removal closes the next piece up
   *  onto the same instant. */
  | { kind: "piece"; start: SourcePoint | null }
  | null;
