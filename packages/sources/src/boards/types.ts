import type { Extraction } from "../extraction.js";

// What every board reader shares (NS-282: split out of list.ts so a feed reader such as hn.ts can
// use them without importing list.ts, which imports it).

// A board with more open postings than this is read up to here (tens of thousands would stall the
// pass); the rest wait for a later ticket.
export const MAX_POSTINGS = 2_000;

export type BoardPosting = {
  // The posting's canonical link, the same one `jobs add` would store for it.
  url: string;
  extraction: Extraction;
};

// The board can't be read this time (an error status, or JSON in a shape we don't know). The
// poll backs the board off; the message is plain words, never the response body.
export class BoardUnavailable extends Error {
  override name = "BoardUnavailable";
}
