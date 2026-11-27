/**
 * The scan's state key, read once and taken out of the environment before any dependency runs: this module imports
 * nothing, and a script that takes the key (scripts/moves.ts, scripts/pins.ts) imports it before anything else, so it
 * is the first module Node evaluates, and nothing those scripts import or start ever finds the key in the environment.
 */

/** The secret's name, state.ts's `STATE_KEY`, written out where nothing is imported: a test holds the two the same. */
export const SCAN_KEY_NAME = 'SCAN_STATE_KEY';

/** The key as the environment held it, or undefined where it held none. */
export const SCAN_KEY: string | undefined = process.env[SCAN_KEY_NAME];
delete process.env[SCAN_KEY_NAME];
