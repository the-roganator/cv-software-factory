/**
 * How many times the reel, a flag's slider in Flags, and the Patching panel have rendered. The drag tests read them
 * (through `?debug=renders`) to prove that dragging draws frames without rendering: the count must not grow with the
 * number of frames. Patching's test reads its count, which its own chunk adds, to prove that an event it does not read renders nothing
 * there.
 */
export const renders: { reel: number; flags: number; patching?: number } = { reel: 0, flags: 0 };

if (new URLSearchParams(location.search).get('debug') === 'renders') {
  (globalThis as { sfRenders?: typeof renders }).sfRenders = renders;
}
