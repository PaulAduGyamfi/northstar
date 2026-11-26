import type { ApplyAts } from "@northstar/domain";
import type { AtsAdapter } from "./adapter.js";
import { ashby } from "./ashby.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { smartrecruiters } from "./smartrecruiters.js";

export type { AtsAdapter } from "./adapter.js";

const ADAPTERS: Readonly<Record<ApplyAts, AtsAdapter>> = {
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
};

export const adapterFor = (ats: ApplyAts): AtsAdapter => ADAPTERS[ats];

// Is this apply URL on the adapter's own host, over https, with no port or credentials? A package
// may never point the gateway at another site.
export function hostAllowed(adapter: AtsAdapter, applyUrl: string): boolean {
  const url = new URL(applyUrl);
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    adapter.hosts.includes(url.hostname)
  );
}
