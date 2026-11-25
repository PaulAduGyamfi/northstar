// Reading a two-column PDF page one column at a time (NS-134, CPG-001). pdf.js reads text across
// the page, so a left-column bullet comes out interleaved with the right column's skills, and the
// model's verbatim quote of the bullet no longer matches the text (ADR-0004 refuses it). Plain
// code over the positions pdf.js reports; a page this doesn't recognise as two columns returns
// null and reads exactly as before.

// One text item as pdf.js reports it: x and y in points from the page's bottom left (y grows up
// the page), width in points.
export type PositionedText = { str: string; x: number; y: number; width: number };

type Line = { y: number; items: PositionedText[] };

// Pieces whose baselines differ by less than this are on the same line (points).
const SAME_LINE = 2;
// A gap wider than this between two pieces of one line is a space (points).
const SPACE_GAP = 1;
// The gutter must sit in the middle half of the page: a date column at the right edge or an
// indent at the left isn't a second column.
const GUTTER_MIN = 0.25;
const GUTTER_MAX = 0.75;
// Each column needs this many lines, so two short lists side by side don't count.
const MIN_COLUMN_LINES = 3;
// A column's lines start at the gutter, give or take this many points.
const ALIGNED = 2;
// At most this share of lines may cross the gutter (a name row, a rule across the page). More
// than that is a one-column page with some indented lines.
const MAX_CROSSING_SHARE = 0.25;

// The page's text in reading order when it has two columns, else null. Rows that cross the
// gutter split the page into bands; each band reads its left column, then its right column.
// Blocks (a crossing row, a band's column) are separated by a blank line.
export function pageText(items: readonly PositionedText[], pageWidth: number): string | null {
  const pieces = items.filter((i) => i.str.trim() !== "");
  if (pieces.length === 0) return null;
  const lines = toLines(pieces);
  const gutter = findGutter(lines, pageWidth);
  if (gutter === null) return null;

  const blocks: string[][] = [];
  let leftBlock: string[] = [];
  let rightBlock: string[] = [];
  const flush = () => {
    if (leftBlock.length > 0) blocks.push(leftBlock);
    if (rightBlock.length > 0) blocks.push(rightBlock);
    leftBlock = [];
    rightBlock = [];
  };
  for (const line of lines) {
    if (crosses(line, gutter)) {
      flush();
      blocks.push([lineText(line.items)]);
      continue;
    }
    const l = line.items.filter((i) => i.x < gutter);
    const r = line.items.filter((i) => i.x >= gutter);
    if (l.length > 0) leftBlock.push(lineText(l));
    if (r.length > 0) rightBlock.push(lineText(r));
  }
  flush();
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

// Groups pieces into lines, top of the page first.
function toLines(pieces: PositionedText[]): Line[] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const p of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(last.y - p.y) < SAME_LINE) last.items.push(p);
    else lines.push({ y: p.y, items: [p] });
  }
  return lines;
}

// The x where the right column starts: a piece's left edge in the middle half of the page, with
// enough lines wholly on each side and few lines across it. The right side must also look like a
// column, not right-aligned dates or a centred heading: at least MIN_COLUMN_LINES lines whose
// right-hand text starts at that x, and at least one of them with nothing on its left (a dated
// entry always has its text on the left). The candidate with the fewest crossing lines wins; ties
// go to the leftmost.
function findGutter(lines: Line[], pageWidth: number): number | null {
  const starts = new Set(
    lines.flatMap((l) =>
      l.items
        .map((i) => i.x)
        .filter((x) => x >= pageWidth * GUTTER_MIN && x <= pageWidth * GUTTER_MAX),
    ),
  );
  let best: { x: number; crossing: number } | null = null;
  for (const x of [...starts].sort((a, b) => a - b)) {
    let leftLines = 0;
    let rightLines = 0;
    let crossing = 0;
    let aligned = 0;
    let alignedAlone = 0;
    for (const line of lines) {
      if (crosses(line, x)) {
        crossing += 1;
        continue;
      }
      const hasLeft = line.items.some((i) => i.x < x);
      const right = line.items.filter((i) => i.x >= x);
      if (hasLeft) leftLines += 1;
      if (right.length === 0) continue;
      rightLines += 1;
      const first = Math.min(...right.map((i) => i.x));
      if (first - x <= ALIGNED) {
        aligned += 1;
        if (!hasLeft) alignedAlone += 1;
      }
    }
    if (leftLines < MIN_COLUMN_LINES || rightLines < MIN_COLUMN_LINES) continue;
    if (aligned < MIN_COLUMN_LINES || alignedAlone === 0) continue;
    if (crossing > lines.length * MAX_CROSSING_SHARE) continue;
    if (best === null || crossing < best.crossing) best = { x, crossing };
  }
  return best?.x ?? null;
}

// A line crosses the gutter when one of its pieces starts left of it and ends right of it.
function crosses(line: Line, gutter: number): boolean {
  return line.items.some((i) => i.x < gutter && i.x + i.width > gutter);
}

// One line's pieces left to right, with a space only where there is a visible gap and neither
// side already has one.
function lineText(items: PositionedText[]): string {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let out = "";
  let end = Number.NEGATIVE_INFINITY;
  for (const i of sorted) {
    const gap = i.x - end > SPACE_GAP;
    if (out !== "" && gap && !/\s$/.test(out) && !/^\s/.test(i.str)) out += " ";
    out += i.str;
    end = i.x + i.width;
  }
  return out.trimEnd();
}
