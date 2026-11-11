/**
 * The package the sample day's app lockfile move carries, which the public view withholds until its pull request is
 * open. A module of its own, so the console's browser tests give it back to Martin's stand-in stream without reading
 * the rest of the day, whose pins name files the browser tests may not read.
 */
export const WITHHELD = {
  name: '@example/parser',
  from: '4.2.0',
  to: '4.2.3',
  pins: [{ file: 'pnpm-lock.yaml', line: 812 }],
};
