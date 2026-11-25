import { pdfToText } from "../text.js";
import { type RenderedPdf, renderResumePdf } from "./pdf.js";
import { renderResumeText } from "./render.js";
import { type PreSendScore, preSendScore } from "./score.js";
import { tailorResume } from "./tailor.js";
import type { MasterResume, TailoredResume, TailorJob } from "./types.js";

// The page budget and the pre-send check on the real PDF (TLR-001, TLR-004, NS-145).

export type FittedResume = { resume: TailoredResume; pdf: RenderedPdf };

// The most lines that fit `maxPages` rendered pages, measured on the PDF rather than guessed with
// a line count. Fewer lines never take more pages (the tailor drops the least relevant line
// first, the deterministic tailor's own order), so a binary search over the line budget finds the
// largest that fits in a handful of renders. Never below one line: a resume that can't fit even
// then comes back with its page count, so the caller sees it.
export async function tailorToPages(
  master: MasterResume,
  job: TailorJob,
  options: { maxPages?: number } = {},
): Promise<FittedResume> {
  const maxPages = options.maxPages ?? 1;
  const render = async (maxLines: number): Promise<FittedResume> => {
    const resume = tailorResume(master, job, { maxLines });
    return { resume, pdf: await renderResumePdf(resume, master) };
  };
  const all = await render(Math.max(1, master.atoms.length));
  if (all.pdf.pages <= maxPages) return all;
  // Invariant: `best` fits (or is the one-line fallback); every budget above `high` doesn't.
  let best = await render(1);
  if (best.pdf.pages > maxPages) return best;
  let low = 2;
  let high = master.atoms.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const tried = await render(mid);
    if (tried.pdf.pages <= maxPages) {
      best = tried;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

// The pre-send score with its ATS check run on the text our own reader gets back from the
// rendered PDF (TLR-004's acceptance criterion), not on the text the PDF was made from.
export async function preSendScoreFromPdf(input: {
  master: MasterResume;
  job: TailorJob;
  resume: TailoredResume;
  pdf: Uint8Array;
}): Promise<PreSendScore> {
  return preSendScore({
    master: input.master,
    job: input.job,
    rendered: renderResumeText(input.resume, input.master),
    reparsed: await pdfToText(input.pdf),
  });
}
