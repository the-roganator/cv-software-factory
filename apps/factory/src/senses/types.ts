/**
 * What a sense hands the runner. A sense checks the app and reports, for each of its checks, a pass or a finding; the
 * runner decides which findings become signals. The probes are the first sense, and the crawler is the second.
 */
import type { ArtifactRef, DefectSymptom, Evidence } from '@software-factory/events';
import type { Check } from '../capture.ts';

/** A check that did not pass: what a fair observer would call it, and the proof. */
export interface Finding {
  symptom: DefectSymptom;
  /** One plain sentence saying what was expected and what was seen. It goes in the log and beside the signal. */
  message: string;
  /** The route as the app names it, when it is not the check's own. */
  route?: string;
  evidence?: Evidence[];
  /** The path of the page to screenshot, when the check is not on it any more. */
  at?: string;
  /** The elements on the page the check ended on to box in the screenshot: at most four. */
  look?: Check[];
}

/** Thrown from deep in a check to end it with a finding, when the check cannot go on. */
export class Found extends Error {
  readonly finding: Finding;

  constructor(finding: Finding) {
    super(finding.message);
    this.finding = finding;
  }
}

/** The result of one check in one pass. */
export interface Observation {
  /** The check's name, which is also the signal's `check`. Stable from one pass to the next. */
  check: string;
  /** What the check found, or null when it passed. */
  finding: Finding | null;
  /** The route the check looked at, as a template, or the finding's own. */
  route: string;
  /** What the check kept as proof, taken when the finding was made. Empty for a pass. */
  artifacts: ArtifactRef[];
  /** Where the screenshot of a finding was taken, and the elements boxed on it: the pictures box them too. */
  look?: { path: string; elements: Check[] };
  /** Set when the check could not tell, such as a timeout or an app that did not answer: neither a pass nor a failure. */
  trouble?: string;
  /**
   * What the pass's pages had left on the device by the end of the check, and the other origins the check's pages asked,
   * from a browser sense asked to look (`device`): the gates', which judge a change, and never the senses'.
   */
  device?: Device;
}

/**
 * What was on the device, as `<kind> <name>`, and the other origins asked, on the check's own route. `allowed` is the
 * app's preview cookie, kept to its contract after the pass asked for a preview; everything else is `kept`.
 */
export interface Device {
  route: string;
  kept: string[];
  allowed: string[];
  asked: string[];
  /** Why what was on the device could not be read, when it could not. */
  trouble?: string;
}

/** One sense: something that can run all its checks against the app, and says what each found. */
export interface Sense {
  readonly name: 'probe' | 'crawler';
  /** Runs every check once against the app, which is at `version`, except those in `skip`. A check's trouble is reported, never thrown. */
  pass(version: string, skip?: ReadonlySet<string>): Promise<Observation[]>;
  /** Checks that may run only so often, by name, in milliseconds. */
  readonly intervals?: Readonly<Record<string, number>>;
}
