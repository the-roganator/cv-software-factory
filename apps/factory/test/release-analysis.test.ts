import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';
import { release } from '../../../policy/release.ts';
import { PUSHED_FRESH } from '../src/alerts/rules.ts';
import { METRICS_FROM_THE_ADMIN_SERVICE, METRICS_FROM_THE_LINE } from '../src/provenance.ts';
import {
  conditions,
  ingressServiceOf,
  OFF_LABEL,
  outOfDate,
  queries,
  render,
  STABLE_SEEN,
  SWITCH_FRESH,
  switched,
  TEMPLATES,
  TEMPLATES_FILE,
  templatesFor,
} from '../src/release/analysis.ts';

interface Metric {
  name: string;
  interval?: string;
  initialDelay?: string;
  successCondition?: string;
  failureCondition?: string;
  failureLimit?: number;
  inconclusiveLimit?: number;
  provider: {
    prometheus?: { query: string };
    job?: { spec: { template: { spec: { containers: { image: string; args: string[] }[] } } } };
  };
}

const metricsOf = (name: string): Metric[] => {
  const template = templatesFor(release).find((t) => t.metadata.name === name);
  if (!template) throw new Error(`no template ${name}`);
  return template.spec.metrics as Metric[];
};

describe('the canary analysis', () => {
  it('fails a step whose canary has had too few requests, and says that is why', () => {
    const [first] = metricsOf(TEMPLATES.step);
    expect(first?.name).toBe('enough-requests');
    expect(first?.successCondition).toBe(`result[0] >= ${release.minRequests}`);
    expect(first?.failureLimit).toBe(0);
    // No requests at all is a count of nought, not an empty answer that a condition cannot read.
    expect(first?.provider.prometheus?.query).toMatch(/or vector\(0\)$/);
  });

  it('counts only what the traffic split sent the canary through the ingress, not the journeys’ own requests', () => {
    const { requests } = queries(release);
    expect(requests).toBe(
      'sum(increase(traefik_service_requests_total{service="website-website-canary-80@kubernetescrd"}[3m])) or vector(0)',
    );
    // The app's own count of the canary's requests includes the journeys, which ask its Service directly.
    expect(requests).not.toContain('http_server_request_duration_seconds');
    expect(requests).not.toContain('canary-hash');
  });

  it('names a Service as Traefik’s metrics do when a weighted service sends to it', () => {
    expect(ingressServiceOf('http://website-canary.website')).toBe('website-website-canary-80@kubernetescrd');
    expect(ingressServiceOf('http://shop.web:8080')).toBe('web-shop-8080@kubernetescrd');
    expect(() => ingressServiceOf('http://website-canary')).toThrow(/<name>\.<namespace>/);
  });

  it('judges errors and latency against the baseline, and only once there is enough to judge', () => {
    const q = queries(release);
    for (const query of [q.errors, q.latency]) {
      expect(query).toContain('{{args.canary-hash}}');
      expect(query).toContain('{{args.stable-hash}}');
      // Judged only once the split has sent the canary enough, so too little traffic fails on that alone.
      expect(query).toMatch(
        new RegExp(`and on \\(\\) sum\\(increase\\(traefik_service_requests_total\\{.*\\) >= ${release.minRequests}$`),
      );
      // Every route at once: no query names one, or depends on how the app names them.
      expect(query).not.toMatch(/http_route="/);
      expect(query).not.toContain('by (http_route)');
    }
    // A canary with no series fails, rather than leaving nothing to judge; one with no stable version to compare with
    // passes (evaluated below, in "with no stable version").
    expect(q.errors).toContain('or on () vector(Inf)');
    expect(q.latency).toContain('or on () vector(Inf)');
    expect(q.errors).toContain('http_response_status_code=~"5.."');
    expect(q.latency).toContain(`histogram_quantile(${release.latency.percentile},`);
    expect(q.latency).toContain(`* ${release.latency.maxRatioAbove}, ${release.latency.minSecondsAbove})`);
    const [, errors, latency] = metricsOf(TEMPLATES.step);
    expect(errors?.successCondition).toBe(`len(result) == 0 || result[0] <= ${release.errors.maxAbove}`);
    expect(latency?.successCondition).toBe('len(result) == 0 || result[0] <= 0');
    // Each judges its figure with the switch.
    expect(errors?.provider.prometheus?.query).toBe(switched(q.errors));
    expect(latency?.provider.prometheus?.query).toBe(switched(q.latency));
  });

  it('runs the journeys gate with the stable Service as the base and the canary as the change', () => {
    const journeys = metricsOf(TEMPLATES.step).find((m) => m.name === 'journeys');
    const [container] = journeys?.provider.job?.spec.template.spec.containers ?? [];
    expect(container?.image).toBe('factory-browser');
    expect(container?.args).toEqual([
      'src/cli.ts',
      'gate',
      'journeys',
      '--base',
      release.app.stable,
      '--change',
      release.app.canary,
    ]);
    expect(journeys?.failureLimit).toBe(0);
  });

  it('looks at every measure throughout, failing on the policy’s count of failed looks', () => {
    const background = metricsOf(TEMPLATES.background);
    expect(background.map((m) => m.name)).toEqual(['errors', 'latency', 'journeys']);
    for (const metric of background) expect(metric.failureLimit).toBe(release.background.failures - 1);
    // With auto-rollback off, paused on the look that would have failed it, not the first bad one.
    for (const metric of background.slice(0, 2)) {
      expect(metric.inconclusiveLimit).toBe(release.background.failures - 1);
    }
    const [errors, latency, journeys] = background;
    expect(errors?.interval).toBe(`${release.background.intervalMinutes}m`);
    expect(latency?.interval).toBe(`${release.background.intervalMinutes}m`);
    // The same Job as at a step, every few minutes, starting half an interval in: between the steps' runs.
    expect(journeys?.provider.job).toEqual(metricsOf(TEMPLATES.step).find((m) => m.name === 'journeys')?.provider.job);
    expect(journeys?.interval).toBe(`${release.background.journeysIntervalMinutes}m`);
    expect(journeys?.initialDelay).toBe(`${release.background.journeysIntervalMinutes * 30}s`);
  });

  it('leave the journeys and too few requests to fail whatever auto-rollback says: neither can be inconclusive', () => {
    for (const metrics of [metricsOf(TEMPLATES.step), metricsOf(TEMPLATES.background)]) {
      for (const metric of metrics.filter((m) => m.name === 'journeys' || m.name === 'enough-requests')) {
        expect(metric.failureCondition, metric.name).toBeUndefined();
        expect(metric.provider.prometheus?.query ?? '', metric.name).not.toContain('auto_rollback');
      }
    }
  });

  it('pause at a step on the first bad figure with auto-rollback off, as they fail on it with it on', () => {
    for (const metric of metricsOf(TEMPLATES.step).filter((m) => m.name === 'errors' || m.name === 'latency')) {
      expect(metric.failureLimit).toBe(0);
      expect(metric.inconclusiveLimit).toBe(0);
    }
  });

  it('follow the policy', () => {
    const stricter = {
      ...release,
      windowMinutes: 5,
      minRequests: 300,
      errors: { maxAbove: 0.005 },
      latency: { percentile: 0.95, maxRatioAbove: 0.1, minSecondsAbove: 0.05 },
    };
    const text = render(stricter);
    expect(text).toContain('[5m]');
    expect(text).toContain('>= 300');
    expect(text).toContain('result[0] <= 0.005');
    expect(text).toContain('histogram_quantile(0.95,');
    expect(text).toContain('* 0.1, 0.05)');
    expect(text).not.toBe(render(release));
  });

  it('are what is committed, as two cluster-scoped templates: the check passes now, and fails when the policy moves on', () => {
    const committed = readFileSync(TEMPLATES_FILE, 'utf8');
    expect(committed).toBe(render(release));
    const documents = parseAllDocuments(committed).map((d) => d.toJS());
    expect(documents.map((d) => [d.kind, d.metadata.name, d.metadata.namespace])).toEqual([
      ['ClusterAnalysisTemplate', TEMPLATES.step, undefined],
      ['ClusterAnalysisTemplate', TEMPLATES.background, undefined],
    ]);
    expect(outOfDate(release)).toBe(false);
    expect(outOfDate({ ...release, minRequests: release.minRequests + 1 })).toBe(true);
  });

  it('fail the check when the file is missing or edited by hand', () => {
    const folder = mkdtempSync(join(tmpdir(), 'analysis-'));
    const file = join(folder, 'templates.yaml');
    expect(outOfDate(release, file)).toBe(true);
    writeFileSync(file, render(release));
    expect(outOfDate(release, file)).toBe(false);
    writeFileSync(file, render(release).replace(`>= ${release.minRequests}`, '>= 1'));
    expect(outOfDate(release, file)).toBe(true);
  });
});

/**
 * A condition as Argo Rollouts evaluates it (expr): `len`, `result`, `||`, `&&` and `!`, which mean in it what they
 * mean in JavaScript, over the answer's figures.
 */
function evaluate(condition: string, result: number[]): boolean {
  return new Function('result', 'len', `return ${condition};`)(result, (a: unknown[]) => a.length) as boolean;
}

/** A measurement's phase from its conditions, as Argo Rollouts decides it: failure first, then success. */
function phase(c: { successCondition: string; failureCondition: string }, result: number[]) {
  if (evaluate(c.failureCondition, result)) return 'Failed';
  return evaluate(c.successCondition, result) ? 'Successful' : 'Inconclusive';
}

/** Runs promtool's rule tests on these, in a folder of their own that it removes: whether they passed, and what it said. */
function promtool(tests: unknown[]): { passed: boolean; output: string } {
  const folder = mkdtempSync(join(tmpdir(), 'promtool-'));
  const file = join(folder, 'tests.yml');
  try {
    writeFileSync(file, stringify({ rule_files: [], evaluation_interval: '15s', tests }, { lineWidth: 0 }));
    return {
      passed: true,
      output: execFileSync('promtool', ['test', 'rules', file], { encoding: 'utf-8', stdio: 'pipe' }),
    };
  } catch (error) {
    const { stdout = '', stderr = '', message } = error as { stdout?: string; stderr?: string; message: string };
    return { passed: false, output: `${message}\n${stdout}${stderr}` };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('auto-rollback, as the analysis reads it', () => {
  const latency = conditions('result[0] <= 0');

  it('passes a good figure, and nothing to judge, whatever the switch', () => {
    expect(phase(latency, [])).toBe('Successful');
    expect(phase(latency, [-0.02])).toBe('Successful');
    expect(phase(latency, [-0.02, -0.02])).toBe('Successful');
  });

  it('fails a bad figure answered once, and calls one answered twice, with the switch off, inconclusive', () => {
    expect(phase(latency, [0.17])).toBe('Failed');
    expect(phase(latency, [0.17, 0.17])).toBe('Inconclusive');
    // A version with nothing to compare is infinitely worse, and NaN is no figure within a limit: both bad.
    expect(phase(latency, [Number.POSITIVE_INFINITY])).toBe('Failed');
    expect(phase(latency, [Number.NaN])).toBe('Failed');
    expect(phase(latency, [Number.NaN, Number.NaN])).toBe('Inconclusive');
    // Any other number of answers fails: only the switch's two are inconclusive.
    expect(phase(latency, [0.17, 0.17, 0.17])).toBe('Failed');
  });

  it('believes the series as the alerts believe a worker’s', () => {
    expect(SWITCH_FRESH).toBe(PUSHED_FRESH);
  });

  /** Whether the switch's query answers its figure twice at 5m, given these series of the switch over the 5 minutes. */
  function offAt5m(series: { series: string; values: string }[], figure = 'sum(figure)'): boolean {
    const test = (expected: number) => ({
      interval: '15s',
      input_series: [{ series: 'figure', values: '0.17x40' }, ...series],
      promql_expr_test: [
        {
          expr: `count(${switched(figure)})`,
          eval_time: '5m',
          exp_samples: [{ labels: '{}', value: expected }],
        },
      ],
    });
    if (promtool([test(2)]).passed) return true;
    // Not two: check it is one, so a query that answers nothing (or fails to parse) does not pass as "on".
    const one = promtool([test(1)]);
    if (!one.passed) throw new Error(`neither one answer nor two:\n${one.output}`);
    return false;
  }

  const admin = (value: string, extra = '') => ({
    series: `admin_auto_rollback{${METRICS_FROM_THE_ADMIN_SERVICE}${extra}}`,
    values: value,
  });
  const line = (value: string, extra = '') => ({
    series: `line_auto_rollback{${METRICS_FROM_THE_LINE}${extra}}`,
    values: value,
  });
  /** Fresh throughout the five minutes, every 15 seconds. */
  const steady = (v: number) => `${v}x20`;

  it('is off only with exactly one fresh series from each pod, both reading 0', () => {
    expect(offAt5m([admin(steady(0)), line(steady(0))])).toBe(true);
  });

  it('is on, and a bad canary rolls back, with anything else', () => {
    // Either on.
    expect(offAt5m([admin(steady(1)), line(steady(0))])).toBe(false);
    expect(offAt5m([admin(steady(0)), line(steady(1))])).toBe(false);
    // Either missing: the admin service down, the line not yet scraped.
    expect(offAt5m([line(steady(0))])).toBe(false);
    expect(offAt5m([admin(steady(0))])).toBe(false);
    expect(offAt5m([])).toBe(false);
    // Either stale: its last sample over a minute old, from a worker gone.
    expect(offAt5m([admin('0x10'), line(steady(0))])).toBe(false);
    // Two series from one pod: which to believe is not known.
    expect(offAt5m([admin(steady(0)), admin(steady(0), ', instance="b"'), line(steady(0))])).toBe(false);
    // Off from any other pod is no word of the admin service's or the line's.
    const triage = 'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="triage"';
    expect(
      offAt5m([
        { series: `admin_auto_rollback{${triage}}`, values: steady(0) },
        { series: `line_auto_rollback{${triage}}`, values: steady(0) },
      ]),
    ).toBe(false);
  });

  it('answers an infinite figure once, whatever the switch: a canary that could not be measured still fails', () => {
    expect(offAt5m([admin(steady(0)), line(steady(0))], 'sum(figure) / 0')).toBe(false);
  });

  it('parses as Prometheus reads it, around the real measures', () => {
    const q = queries(release);
    const real = (query: string) =>
      switched(query).replaceAll('{{args.canary-hash}}', 'c4n4ry').replaceAll('{{args.stable-hash}}', 's74b1e');
    const parsed = promtool([
      {
        interval: '15s',
        input_series: [],
        promql_expr_test: [q.errors, q.latency].map((query) => ({
          expr: real(query),
          eval_time: '5m',
          exp_samples: [],
        })),
      },
    ]);
    expect(parsed.passed, parsed.output).toBe(true);
    expect(parsed.output).toContain('SUCCESS');
  });
});

describe('with no stable version, as the analysis reads it', () => {
  const CANARY = 'c4n4ry';
  const STABLE = 's74b1e';
  /**
   * A counter sampled every 15s for ten minutes, `step` more each time (60 is 4 a second); with `until`, its samples
   * stop after that many steps, as a version's telemetry does when it goes dark. Evaluated at 5m.
   */
  const counter = (step: number, until = 40) => (until < 40 ? `0+${step}x${until} _x${40 - until}` : `0+${step}x40`);
  const of = (hash: string, extra = '') =>
    `{job="${release.app.metricsJob}", http_route="/", k8s_pod_label_rollouts_pod_template_hash="${hash}"${extra}}`;
  /** A version's requests, 4 a second, a share of them 5xx, each answered within `le` seconds. */
  const version = (
    hash: string,
    { errors = 0, le = '0.1', until = 40 }: { errors?: number; le?: string; until?: number } = {},
  ) => [
    {
      series: `http_server_request_duration_seconds_count${of(hash, ', http_response_status_code="200"')}`,
      values: counter(60 * (1 - errors), until),
    },
    {
      series: `http_server_request_duration_seconds_count${of(hash, ', http_response_status_code="500"')}`,
      values: counter(60 * errors, until),
    },
    ...['0.1', '0.5', '+Inf'].map((bucket) => ({
      series: `http_server_request_duration_seconds_bucket${of(hash, `, le="${bucket}"`)}`,
      values: counter(Number(bucket) >= Number(le) ? 60 : 0, until),
    })),
  ];
  /** What the split sent the canary through the ingress: enough to judge. */
  const split = {
    series: `traefik_service_requests_total{service="${ingressServiceOf(release.app.canary)}"}`,
    values: counter(60),
  };
  const switchOff = [
    { series: `admin_auto_rollback{${METRICS_FROM_THE_ADMIN_SERVICE}}`, values: '0x40' },
    { series: `line_auto_rollback{${METRICS_FROM_THE_LINE}}`, values: '0x40' },
  ];

  /**
   * Has promtool evaluate a template's measure at 5m over these series and check it answers exactly these figures (the
   * second under the switch's label), then gives the measurement's phase from the template's own conditions.
   */
  function judge(
    template: string,
    name: string,
    series: { series: string; values: string }[],
    figures: number[],
    { interval = '15s', at = '5m' } = {},
  ) {
    const metric = metricsOf(template).find((m) => m.name === name);
    const query = metric?.provider.prometheus?.query;
    if (!metric?.successCondition || !metric.failureCondition || !query) throw new Error(`no measure ${name}`);
    const labels = ['{}', `{${OFF_LABEL}="off"}`];
    const run = promtool([
      {
        interval,
        input_series: series,
        promql_expr_test: [
          {
            expr: query.replaceAll('{{args.canary-hash}}', CANARY).replaceAll('{{args.stable-hash}}', STABLE),
            eval_time: at,
            exp_samples: figures.map((value, i) => ({ labels: labels[i], value })),
          },
        ],
      },
    ]);
    if (!run.passed) throw new Error(`${template} ${name} did not answer ${JSON.stringify(figures)}:\n${run.output}`);
    return phase({ successCondition: metric.successCondition, failureCondition: metric.failureCondition }, figures);
  }

  const measures = [TEMPLATES.step, TEMPLATES.background].flatMap((template) =>
    ['errors', 'latency'].map((name) => ({ template, name })),
  );
  /** A bad canary for each measure: a tenth of its answers 5xx, or every answer slower than 100 ms. */
  const bad = (name: string) => (name === 'errors' ? { errors: 0.1 } : { le: '0.5' });
  /** What a bad canary's figure is against a good stable version: 0.1 more 5xx; p99 0.496 s against 0.099 + 0.1 s. */
  const badFigure = (name: string) => (name === 'errors' ? 0.1 : 0.297);
  /** A good canary's against a good stable version: no more 5xx; p99 0.099 s against 0.099 + 0.1 s. */
  const goodFigure = (name: string) => (name === 'errors' ? 0 : -0.1);

  it.each(measures)(
    '$template $name compares the canary with the stable version, exactly as before, when it has one',
    ({ template, name }) => {
      expect(judge(template, name, [...version(CANARY), ...version(STABLE), split], [goodFigure(name)])).toBe(
        'Successful',
      );
      expect(judge(template, name, [...version(CANARY, bad(name)), ...version(STABLE), split], [badFigure(name)])).toBe(
        'Failed',
      );
      // With auto-rollback off, the bad figure pauses the canary rather than failing it.
      expect(
        judge(
          template,
          name,
          [...version(CANARY, bad(name)), ...version(STABLE), split, ...switchOff],
          [badFigure(name), badFigure(name)],
        ),
      ).toBe('Inconclusive');
    },
  );

  it.each(measures)(
    '$template $name passes a canary with no stable version to compare with, good or bad',
    ({ template, name }) => {
      expect(judge(template, name, [...version(CANARY), split], [0])).toBe('Successful');
      expect(judge(template, name, [...version(CANARY, bad(name)), split], [0])).toBe('Successful');
      expect(judge(template, name, [...version(CANARY), split, ...switchOff], [0, 0])).toBe('Successful');
    },
  );

  it.each(measures)(
    '$template $name still fails a canary with nothing measured, with a stable version or none',
    ({ template, name }) => {
      expect(judge(template, name, [...version(STABLE), split], [Number.POSITIVE_INFINITY])).toBe('Failed');
      expect(judge(template, name, [split], [Number.POSITIVE_INFINITY])).toBe('Failed');
      expect(judge(template, name, [split, ...switchOff], [Number.POSITIVE_INFINITY])).toBe('Failed');
    },
  );

  it.each(measures)(
    '$template $name fails a canary whose stable version went dark in the window, as before',
    ({ template, name }) => {
      const dark = [...version(CANARY), ...version(STABLE, { until: 4 }), split];
      // The stable version served until 1m and has nothing in the window from 2m: a gap in its telemetry, not a reset.
      expect(judge(template, name, dark, [Number.POSITIVE_INFINITY])).toBe('Failed');
      // So is one sampled with counters that never grew: seen, the stricter reading, not none.
      const flat = version(STABLE, { until: 4 }).map((v) => ({ ...v, values: counter(0, 4) }));
      expect(judge(template, name, [...version(CANARY), ...flat, split], [Number.POSITIVE_INFINITY])).toBe('Failed');
      // A stable version that answers on no route the app named is seen too: nothing to compare, but not none.
      const unrouted = version(STABLE).map((v) => ({
        ...v,
        series: v.series.replace('http_route="/"', 'http_route=""'),
      }));
      expect(judge(template, name, [...version(CANARY), ...unrouted, split], [Number.POSITIVE_INFINITY])).toBe(
        'Failed',
      );
    },
  );

  it.each(measures)(
    '$template $name fails a canary with series whose requests did not grow, with no stable version',
    ({ template, name }) => {
      const flat = version(CANARY).map((v) => ({ ...v, values: counter(0) }));
      expect(judge(template, name, [...flat, split], [Number.POSITIVE_INFINITY])).toBe('Failed');
    },
  );

  it.each(measures)(
    `$template $name calls a stable version not measured for ${STABLE_SEEN} none, and one measured within it a gap`,
    ({ template, name }) => {
      // Every minute for 25 hours: the canary and the split from 1490m, judged at 1500m.
      const late = (v: { series: string; values: string }) => ({ ...v, values: `_x1490 ${v.values}` });
      const canary = [...version(CANARY), split].map(late);
      const daily = { interval: '1m', at: '1500m' };
      // The stable version served from 0 to 10m, more than a day before: no baseline.
      expect(judge(template, name, [...canary, ...version(STABLE, { until: 10 })], [0], daily)).toBe('Successful');
      // It served from 100m to 110m, within the day: a gap in its telemetry.
      const within = version(STABLE, { until: 10 }).map((v) => ({ ...v, values: `_x100 ${v.values}` }));
      expect(judge(template, name, [...canary, ...within], [Number.POSITIVE_INFINITY], daily)).toBe('Failed');
    },
  );

  it.each(measures)(
    '$template $name judges nothing before the split has sent the canary enough',
    ({ template, name }) => {
      expect(judge(template, name, version(CANARY), [])).toBe('Successful');
    },
  );
});
