/**
 * The package the sample day's app lockfile move carries, which the public view withholds, as it withholds every
 * lockfile move's package (packages/events/src/public.ts): the line's work item #1335 moves it, and the day lists it.
 */
export const WITHHELD = {
  name: '@example/parser',
  from: '4.2.0',
  to: '4.2.3',
  pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
};
