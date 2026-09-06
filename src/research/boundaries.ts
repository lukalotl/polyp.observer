import type { BoundaryContacts, BoundaryPolicy } from "./types";

export const SPATIAL_WALLS = ["left", "right", "front", "back"] as const;

export function isDisqualified(
  contacts: BoundaryContacts,
  policy: BoundaryPolicy,
): boolean {
  return (
    (policy.spatial && SPATIAL_WALLS.some((wall) => contacts[wall] !== null)) ||
    (policy.horizon && contacts.horizon)
  );
}

/** Contact times describe the complete fixture, even for a cropped preview. */
export function boundaryDescription(
  contacts: BoundaryContacts,
  finalTime: number,
): string {
  const entries = SPATIAL_WALLS.filter((wall) => contacts[wall] !== null).map(
    (wall) => `${wall} at t=${contacts[wall]}`,
  );
  if (contacts.horizon) entries.push(`time cutoff at t=${finalTime}`);
  return entries.length ? entries.join(" · ") : "No boundary contact";
}
