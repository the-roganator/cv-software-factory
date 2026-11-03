/**
 * Which attacks the page offers Martin to launch: policy's (`attackAvailable` in `policy/attacks.ts`), which holds
 * them all back until the harness that makes them is built. A browser test stands in for that flag, to draw an attack's
 * Launch and dialog as they will be, by setting `__attacksAvailable` on the page before it loads
 * (`e2e/support.ts`, `attacksAvailable`); nothing else sets it. It changes only what that one page draws: the admin
 * service decides for itself, and refuses a launch of an attack policy holds back.
 */
import type { Attack } from '@software-factory/events';
import { attackAvailable } from '@software-factory/policy/attacks';

const standIn = (globalThis as { __attacksAvailable?: unknown }).__attacksAvailable === true;

export const attacksOffered: (attack: Attack) => boolean = standIn ? () => true : attackAvailable;
