-- NS-231 slice 5 (DX-010, NFR-SEC-004): the database refuses the invisible characters that
-- `parseIndependentWork` (packages/profile) refuses since slice 3, so a writer that skips the
-- parser still can't store a right-to-left override, a zero-width space, a line separator or a
-- blank-looking filler in a title, link or line that goes verbatim into resumes and LinkedIn copy.
--
-- Postgres regular expressions have no Unicode property classes, so the class lists the code points
-- the parser's pattern matches (Unicode 17 `Cf`, `Zl`, `Zp`, U+115F, U+1160, U+3164, U+FFA0,
-- U+2800, U+034F and the variation selectors), generated from Node's own tables, every one as an
-- ASCII escape (`\uXXXX`, `\UXXXXXXXX`; standard_conforming_strings is on), so this file holds none
-- of the characters it refuses. A test in packages/profile (`independent-work-db.test.ts`) checks
-- the database refuses every one of them.
--
-- NOT VALID: new rows are checked, and a row stored before slice 3 can't fail this migration. The
-- tables are append-only, so no old row is ever rewritten.
ALTER TABLE independent_work_entry ADD CONSTRAINT independent_work_entry_title_no_invisible
  CHECK (title !~ '[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f\U000e0100-\U000e01ef]') NOT VALID;
--> statement-breakpoint
ALTER TABLE independent_work_entry ADD CONSTRAINT independent_work_entry_link_no_invisible
  CHECK (link IS NULL OR link !~ '[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f\U000e0100-\U000e01ef]') NOT VALID;
--> statement-breakpoint
ALTER TABLE independent_work_line ADD CONSTRAINT independent_work_line_text_no_invisible
  CHECK (text !~ '[\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f\U000e0100-\U000e01ef]') NOT VALID;
