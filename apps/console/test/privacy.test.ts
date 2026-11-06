/**
 * The privacy page's figures against where each is set: what Loki, Tempo and Prometheus keep, how long the admin
 * service counts the tries to sign in from one address, and the app's preview cookie as the probes' `/device` check
 * allows it. The session's hour is held by `access.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../../factory/src/admin/client.ts';
import { PREVIEW_COOKIE } from '../../factory/src/senses/device.ts';
import { KEPT_DAYS, PREVIEW, TRIES_MINUTES } from '../web/src/privacy.ts';

/** The one duration a values file sets by `pattern`, which must match once. */
function setting(file: string, pattern: RegExp): string {
  const text = readFileSync(new URL(`../../../deploy/base/telemetry/values/${file}`, import.meta.url), 'utf-8');
  const found = [...text.matchAll(new RegExp(pattern, 'gm'))];
  if (found.length !== 1 || !found[0]?.[1]) throw new Error(`${file} sets ${pattern} ${found.length} times`);
  return found[0][1];
}

const days = (duration: string) => {
  const match = /^(\d+)(h|d)$/.exec(duration);
  if (!match) throw new Error(`${duration} is not in hours or days`);
  return Number(match[1]) / (match[2] === 'h' ? 24 : 1);
};

describe('what the privacy page says the server keeps', () => {
  it('keeps logs, traces and metrics as long as Loki, Tempo and Prometheus do', () => {
    expect(days(setting('loki.yaml', /^ {4}retention_period: (\S+)$/))).toBe(KEPT_DAYS.logs);
    expect(days(setting('tempo.yaml', /^ {2}retention: (\S+)$/))).toBe(KEPT_DAYS.traces);
    expect(days(setting('prometheus.yaml', /^ {4}retention:\n {6}time: (\S+)$/))).toBe(KEPT_DAYS.metrics);
  });

  it('counts the tries to sign in for as long as the admin service does', () => {
    expect(LIMITS['sign-in'].minutes).toBe(TRIES_MINUTES);
    expect(LIMITS.enrol.minutes).toBe(TRIES_MINUTES);
  });
});

describe('what the privacy page says the app keeps', () => {
  it('names the preview cookie, and the time it lasts, as the probes’ `/device` check allows them', () => {
    expect(PREVIEW.cookie).toBe(PREVIEW_COOKIE.name);
    expect(PREVIEW.hours * 3600).toBe(PREVIEW_COOKIE.maxAgeSeconds);
  });
});
