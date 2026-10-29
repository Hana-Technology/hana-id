// The build's pinned-CKD-key check is @hana-id/core's (ckd.ts, moved there from apps/smoke): it refuses the UNSET
// placeholder and any key that doesn't decode to a valid compressed G2 point.
export { ckdKeyProblem } from '@hana-id/core';
