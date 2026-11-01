/**
 * The senses in the console's words: one table, so the line, a sheet, its pictures and the audit log cannot name one
 * differently.
 */
import type { Sense } from '@software-factory/events';

interface SenseWords {
  /** As the line lists where triage takes work from, and a sheet's Seen by: "Probes". */
  group: string;
  /** What captured a picture or a piece of evidence, and who found a ticket: "Probe". */
  name: string;
  /** In a sentence: "the probe". */
  the: string;
  /** Whose check verified a fix, in a sentence: "the probe’s check". */
  check: string;
  /** What it watches, under its name on the line. */
  watches: string;
}

export const SENSE: Record<Sense, SenseWords> = {
  probe: {
    group: 'Probes',
    name: 'Probe',
    the: 'the probe',
    check: 'the probe’s check',
    watches: 'a visitor’s journeys',
  },
  crawler: {
    group: 'Crawler',
    name: 'Crawler',
    the: 'the crawler',
    check: 'the crawler’s check',
    watches: 'every page and file',
  },
  metrics: {
    group: 'Metrics',
    name: 'Metrics',
    the: 'the metrics',
    check: 'the metrics’ check',
    watches: 'the app’s objectives',
  },
  logs: {
    group: 'Logs',
    name: 'Log watcher',
    the: 'the log watcher',
    check: 'the log watcher’s check',
    watches: 'new error patterns',
  },
  canary: {
    group: 'Canary',
    name: 'Canary',
    the: 'the canary',
    check: 'the canary’s check',
    watches: 'a release against its baseline',
  },
  report: { group: 'Reports', name: 'Report', the: 'a report', check: 'the check', watches: 'from the widget' },
};
