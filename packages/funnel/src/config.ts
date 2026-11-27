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

// `funnel prep`'s settings (NS-241 slice 5): where Paul's working day is, for the prep planner.
export type PrepConfig = {
  // An IANA zone: PREP_TIME_ZONE, else the fresh-job alerts' ALERT_TIME_ZONE.
  timeZone: string;
  // Minutes after local midnight, start before end.
  workingHours: { start: number; end: number };
};

// 9 to 5 unless Paul sets PREP_WORKING_HOURS.
const DEFAULT_WORKING_HOURS = { start: 9 * 60, end: 17 * 60 };
const HOURS = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;

// The zone must be one this machine knows: an unknown one throws a RangeError here.
const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const minutes = (h: string, m: string) => Number(h) * 60 + Number(m);

// Read only by `funnel prep`, so a missing zone never stops the other commands. A bad value is
// refused naming the setting, never echoing it (a zone says where Paul lives).
export function loadPrepConfig(env: Readonly<Record<string, string | undefined>>): PrepConfig {
  const own = env.PREP_TIME_ZONE;
  const zone = own !== undefined && own !== "" ? own : env.ALERT_TIME_ZONE;
  const zoneName = own !== undefined && own !== "" ? "PREP_TIME_ZONE" : "ALERT_TIME_ZONE";
  if (zone === undefined || zone === "") {
    throw new FunnelConfigError("PREP_TIME_ZONE (or ALERT_TIME_ZONE) must name your time zone");
  }
  if (!knownZone(zone)) throw new FunnelConfigError(`${zoneName} is not a known IANA time zone`);
  const raw = env.PREP_WORKING_HOURS;
  if (raw === undefined || raw === "") {
    return { timeZone: zone, workingHours: DEFAULT_WORKING_HOURS };
  }
  const m = HOURS.exec(raw);
  const start = m ? minutes(m[1] as string, m[2] as string) : 0;
  const end = m ? minutes(m[3] as string, m[4] as string) : 0;
  if (!m || start >= end || end > 24 * 60) {
    throw new FunnelConfigError("PREP_WORKING_HOURS must be HH:MM-HH:MM, start before end");
  }
  return { timeZone: zone, workingHours: { start, end } };
}
