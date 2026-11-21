import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  FLAGS_CHECKED,
  FLAGS_DIFFER_MINUTES,
  FLAGS_DIFFERING,
  FLAGS_NARROWING,
  FLAGS_NARROWING_SECONDS,
  FLAGS_SET,
  flagRules,
  LEVELS,
  RULES_FILE,
} from '../src/alerts/rules.ts';
import { METRICS_FROM_THE_ADMIN_SERVICE } from '../src/provenance.ts';

/**
 * The alerts that say whether the app holds the flags as Martin set them, run by Prometheus's own rule tester
 * (`promtool test rules`, held in mise.toml to the server's minor release) against the rules file as committed: each fires
 * when it should, at its level, and not before, nor for another pod's series.
 */
interface Rule {
  alert: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

const committed = () => {
  const values = parse(readFileSync(RULES_FILE, 'utf8')) as {
    serverFiles: { 'alerting_rules.yml': { groups: { name: string; rules: Rule[] }[] } };
  };
  return values.serverFiles['alerting_rules.yml'].groups.filter((group) => group.name === 'flags');
};

/** A series by its name, as the admin service's pod sends it, or as another pod's. */
const admin = (name: string) => `${name}{${METRICS_FROM_THE_ADMIN_SERVICE}}`;
const other = (name: string) => `${name}{k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="line"}`;

/** What promtool expects of an alert that fires: the rule's labels and its annotations, as written. */
const firing = (name: string, which = 0) => {
  const rule = flagRules().filter((r) => r.alert === name)[which];
  if (!rule) throw new Error(`No rule ${name}`);
  return { exp_labels: rule.labels, exp_annotations: rule.annotations };
};

interface Case {
  interval: string;
  input_series: { series: string; values: string }[];
  alert_rule_test: { eval_time: string; alertname: string; exp_alerts: unknown[] }[];
}

/**
 * promtool is a program of its own, started for each test: on a busy CI runner one test's run of it has taken over five
 * seconds, vitest's default for a test, so each here has longer.
 */
const PROMTOOL = { timeout: 30_000 };

/** Runs promtool over the committed rules with these cases, and gives back what it says when any fails. */
function promtool(tests: Case[]): { ok: boolean; output: string } {
  const folder = mkdtempSync(join(tmpdir(), 'flag-alerts-'));
  writeFileSync(join(folder, 'rules.yml'), stringify({ groups: committed() }));
  writeFileSync(
    join(folder, 'tests.yml'),
    stringify({ rule_files: ['rules.yml'], evaluation_interval: '1m', tests }, { lineWidth: 0 }),
  );
  try {
    return {
      ok: true,
      output: execFileSync('promtool', ['test', 'rules', join(folder, 'tests.yml')], { encoding: 'utf-8' }),
    };
  } catch (error) {
    const { stdout = '', stderr = '', message } = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${stdout}${stderr}` || message };
  }
}

/** A value each minute from the first, as promtool's `values` writes them. */
const each = (...values: (number | '_')[]) => values.join(' ');

/** How long the app has differed, a sample a minute, from 0 to past the five minutes. */
const DIFFERING_UP = each(0, 0, 60, 120, 180, 240, 300, 360, 420);

describe('the alerts on the flags the app holds', PROMTOOL, () => {
  it('are the rules file’s, generated from the policy, in a group of their own', () => {
    expect(committed().flatMap((group) => group.rules.map((rule) => rule.alert))).toEqual(
      flagRules().map((rule) => rule.alert),
    );
    // Only the admin service's own series, by what the collector stamps on them.
    for (const series of [FLAGS_DIFFERING, FLAGS_NARROWING, FLAGS_CHECKED, FLAGS_SET]) {
      expect(series).toContain(METRICS_FROM_THE_ADMIN_SERVICE);
    }
    expect(FLAGS_DIFFER_MINUTES).toBe(5);
    expect(FLAGS_NARROWING_SECONDS).toBe(60);
  });

  it('page when a narrowing or Off has not reached the app within a minute, and only then', () => {
    expect(firing('FlagsNotTaken').exp_labels.level).toBe(LEVELS.page);
    const { ok, output } = promtool([
      {
        interval: '1m',
        // Not taken: a minute, then more.
        input_series: [{ series: admin('admin_flags_narrowing_seconds'), values: each(0, 0, 30, 60, 90, 150) }],
        alert_rule_test: [
          { eval_time: '3m', alertname: 'FlagsNotTaken', exp_alerts: [] },
          { eval_time: '4m', alertname: 'FlagsNotTaken', exp_alerts: [firing('FlagsNotTaken')] },
        ],
      },
      {
        interval: '1m',
        // Not seen taken because no pod could be asked: a kill switch nothing shows working pages as well.
        input_series: [
          { series: admin('admin_flags_narrowing_seconds'), values: each(0, 0, 30, 60, 90) },
          { series: admin('admin_flags_checked'), values: each(1, 0, 0, 0, 0) },
        ],
        alert_rule_test: [{ eval_time: '4m', alertname: 'FlagsNotTaken', exp_alerts: [firing('FlagsNotTaken')] }],
      },
      {
        interval: '1m',
        // Taken within the minute: never.
        input_series: [{ series: admin('admin_flags_narrowing_seconds'), values: each(0, 20, 50, 0, 0, 0) }],
        alert_rule_test: [{ eval_time: '5m', alertname: 'FlagsNotTaken', exp_alerts: [] }],
      },
      {
        interval: '1m',
        // Another pod's series by that name changes nothing.
        input_series: [{ series: other('admin_flags_narrowing_seconds'), values: each(0, 300, 600) }],
        alert_rule_test: [{ eval_time: '2m', alertname: 'FlagsNotTaken', exp_alerts: [] }],
      },
    ]);
    expect(ok, output).toBe(true);
  });

  it('notify when the app has held other flags for more than five minutes, while every pod answers', () => {
    expect(firing('FlagsDiffer').exp_labels.level).toBe(LEVELS.notify);
    const { ok, output } = promtool([
      {
        interval: '1m',
        input_series: [
          { series: admin('admin_flags_differing_seconds'), values: DIFFERING_UP },
          { series: admin('admin_flags_checked'), values: each(1, 1, 1, 1, 1, 1, 1, 1, 1) },
          { series: admin('admin_flags_set'), values: each(1, 1, 1, 1, 1, 1, 1, 1, 1) },
        ],
        alert_rule_test: [
          // Exactly five minutes is not more than five.
          { eval_time: '6m', alertname: 'FlagsDiffer', exp_alerts: [] },
          { eval_time: '7m', alertname: 'FlagsDiffer', exp_alerts: [firing('FlagsDiffer')] },
          { eval_time: '7m', alertname: 'FlagsUnchecked', exp_alerts: [] },
        ],
      },
      {
        interval: '1m',
        // A pod that misses one check meanwhile does not swap this alert for the other.
        input_series: [
          { series: admin('admin_flags_differing_seconds'), values: DIFFERING_UP },
          { series: admin('admin_flags_checked'), values: each(1, 1, 1, 1, 1, 1, 1, 0, 1) },
        ],
        alert_rule_test: [
          { eval_time: '7m', alertname: 'FlagsDiffer', exp_alerts: [firing('FlagsDiffer')] },
          { eval_time: '7m', alertname: 'FlagsUnchecked', exp_alerts: [] },
        ],
      },
      {
        interval: '1m',
        // Held again: the count goes back to 0, and the alert with it.
        input_series: [
          { series: admin('admin_flags_differing_seconds'), values: each(300, 360, 0, 0) },
          { series: admin('admin_flags_checked'), values: each(1, 1, 1, 1) },
        ],
        alert_rule_test: [
          { eval_time: '1m', alertname: 'FlagsDiffer', exp_alerts: [firing('FlagsDiffer')] },
          { eval_time: '2m', alertname: 'FlagsDiffer', exp_alerts: [] },
        ],
      },
      {
        interval: '1m',
        input_series: [
          { series: other('admin_flags_differing_seconds'), values: DIFFERING_UP },
          { series: other('admin_flags_checked'), values: each(1, 1, 1, 1, 1, 1, 1, 1, 1) },
        ],
        alert_rule_test: [{ eval_time: '8m', alertname: 'FlagsDiffer', exp_alerts: [] }],
      },
    ]);
    expect(ok, output).toBe(true);
  });

  it('notify when the admin service has not asked every pod for five minutes, or its figures have gone while flags were set', () => {
    for (const which of [0, 1]) expect(firing('FlagsUnchecked', which).exp_labels.level).toBe(LEVELS.notify);
    const { ok, output } = promtool([
      {
        interval: '1m',
        // Could not ask: the count goes on, and the last check says why.
        input_series: [
          { series: admin('admin_flags_differing_seconds'), values: DIFFERING_UP },
          { series: admin('admin_flags_checked'), values: each(1, 0, 0, 0, 0, 0, 0, 0, 0) },
          { series: admin('admin_flags_set'), values: each(1, 1, 1, 1, 1, 1, 1, 1, 1) },
        ],
        alert_rule_test: [
          { eval_time: '6m', alertname: 'FlagsUnchecked', exp_alerts: [] },
          { eval_time: '7m', alertname: 'FlagsUnchecked', exp_alerts: [firing('FlagsUnchecked')] },
          { eval_time: '7m', alertname: 'FlagsDiffer', exp_alerts: [] },
        ],
      },
      {
        interval: '1m',
        // The admin service's figures stop, ten minutes in, with a flag set: told once Prometheus no longer finds a
        // sample, five minutes on.
        input_series: [
          { series: admin('admin_flags_set'), values: '1x10' },
          { series: admin('admin_flags_differing_seconds'), values: '0x10' },
          { series: admin('admin_flags_checked'), values: '1x10' },
        ],
        alert_rule_test: [
          { eval_time: '10m', alertname: 'FlagsUnchecked', exp_alerts: [] },
          { eval_time: '14m', alertname: 'FlagsUnchecked', exp_alerts: [] },
          { eval_time: '16m', alertname: 'FlagsUnchecked', exp_alerts: [firing('FlagsUnchecked', 1)] },
        ],
      },
      {
        interval: '1m',
        // With no flag set, the app says `none`, and the figures going is no change missed.
        input_series: [
          { series: admin('admin_flags_set'), values: '0x10' },
          { series: admin('admin_flags_differing_seconds'), values: '0x10' },
        ],
        alert_rule_test: [{ eval_time: '16m', alertname: 'FlagsUnchecked', exp_alerts: [] }],
      },
      {
        interval: '1m',
        // Another pod's say that flags were set is not believed.
        input_series: [{ series: other('admin_flags_set'), values: '1x10' }],
        alert_rule_test: [{ eval_time: '16m', alertname: 'FlagsUnchecked', exp_alerts: [] }],
      },
    ]);
    expect(ok, output).toBe(true);
  });
});
