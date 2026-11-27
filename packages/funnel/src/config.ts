// The funnel commands' own settings, read in one place (AGENTS.md: app code never reads
// process.env directly; bin.ts passes it here). Today only the recruiter-extract switch.

export type FunnelConfig = {
  // NS-238 item 1 slice 2: whether `funnel inbox` reads recruiter emails with the
  // recruiter-extract route to grade them. Off unless Paul turns it on (#266).
  recruiterExtract: boolean;
};

export class FunnelConfigError extends Error {
  override name = "FunnelConfigError";
}

// `on` or `off`; unset means off. Anything else is refused, naming the setting and never echoing
// its value.
export function loadFunnelConfig(env: Readonly<Record<string, string | undefined>>): FunnelConfig {
  const raw = env.RECRUITER_EXTRACT;
  if (raw === undefined || raw === "" || raw === "off") return { recruiterExtract: false };
  if (raw === "on") return { recruiterExtract: true };
  throw new FunnelConfigError("RECRUITER_EXTRACT must be on or off");
}
