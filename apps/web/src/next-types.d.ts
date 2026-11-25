/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Next's ambient types for tsc. next-env.d.ts (gitignored) adds generated route types after a
// build; typecheck runs before the build in CI, so it must not depend on them.
