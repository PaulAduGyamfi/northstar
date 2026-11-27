# NS-259: Changing a search preference after the first one fails with a duplicate id

Issue: #369 · Parent: #15 (NS-116) · Requirements: SRC-017 (preferences take effect at once)

## Problem

After the first `jobs prefs set`, every later one fails with `jobs: Error`. Postgres says
`duplicate key value violates unique constraint "search_preference_pkey"`.

`setPref` (`packages/sources/src/fit/cli.ts`) passes the stored `Preferences`, which carry their
row `id` and `version`, through `applyPreference`, which spreads `...current`. `savePreferences`
(`packages/db/src/fit-write.ts`) then spread `...input.values` into the insert after `version`, so
the new row reused the old row's id and version. The first save worked only because it starts
from `PREFERENCE_DEFAULTS`, which has no id.

## Fix

`savePreferences` copies only the preference fields (`KEYS`) out of `input.values`, and writes
`candidateId` and `version` after them. The fix sits where every writer goes through, so any
caller that passes stored preferences back is covered, not only the CLI.

No migration, no schema change, no event change.

## Test

`packages/db/src/fit.test.ts`: "stores a change made from the stored preferences as a new row and
version". It saves the defaults, reads them back, and saves `{ ...stored, seniority: ["senior"] }`,
as the CLI does. It fails with 23505 without the fix.
