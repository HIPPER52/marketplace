/**
 * How long a session survives without being touched.
 *
 * Rolling, not absolute: every request pushes the expiry back, so a person working stays
 * logged in and a person who walked away does not. Thirty minutes is the usual shape of
 * that trade — long enough that a coffee break is not an interruption, short enough that
 * an abandoned browser in an office is not a standing invitation.
 */
export const SESSION_TTL_SEC = 1_800;
