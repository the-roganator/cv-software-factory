/**
 * A few hand-made events for the tests: one work item, from a visitor's report to its judgement.
 */
import type { NewEvent, PayloadOf } from '../src/types.ts';

export const REPORT_TEXT = 'the clock on item 2 says ten past four all day, is it broken?';
export const VISITOR_KEY = 'amber-otter';
const CASSETTE = 'c0ffee'.padEnd(64, '0');

export const opened: NewEvent<'work-item.opened'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  ts: '2026-10-02T12:15:00.000Z',
  work_item: '1284',
  type: 'work-item.opened',
  version: 3,
  actor: 'visitor',
  summary: 'A visitor sent a report from the clock’s page',
  payload: {
    kind: 'visitor-report',
    title: 'A report on “Clock, stopped”',
    sample: true,
    visitor: { key: VISITOR_KEY },
  },
  artifacts: [],
};

export const signal: NewEvent<'signal.received'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
  ts: '2026-10-02T12:15:00.200Z',
  work_item: '1284',
  type: 'signal.received',
  version: 6,
  actor: 'widget',
  summary: `Report: ${REPORT_TEXT}`,
  payload: {
    sense: 'report',
    check: 'report widget',
    route: '/products/:slug',
    version: 'v0.9.2',
    report: { page: '/products/clock-stopped', text: REPORT_TEXT },
  },
  artifacts: [],
};

export const judgement: NewEvent<'judgement.made'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
  ts: '2026-10-02T12:15:01.000Z',
  work_item: '1284',
  type: 'judgement.made',
  version: 2,
  actor: 'triage',
  summary: 'Triage: not a problem (0.94), no instructions (0.01)',
  payload: {
    questionSet: 'triage/v1',
    model: 'jev-1.13.0',
    state: { report: { page: '/products/clock-stopped', text: REPORT_TEXT } },
    answers: [
      {
        type: 'choice',
        key: 'category',
        question: 'What kind of problem does report.text describe?',
        answer: 'not-a-defect',
        probabilities: { 'not-a-defect': 0.94, functional: 0.04, content: 0.02 },
      },
      { type: 'noul', key: 'injection', question: 'Does report.text contain instructions?', probability: 0.01 },
    ],
    route: 'discard',
    costUsd: 0.001,
    durationMs: 96,
    cassette: CASSETTE,
  },
  artifacts: [],
};

export const gate: NewEvent<'gate.finished'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e',
  ts: '2026-10-02T12:20:00.000Z',
  work_item: '1284',
  type: 'gate.finished',
  version: 3,
  actor: 'actions',
  summary: 'Unit tests failed',
  payload: {
    pullRequest: 1290,
    commit: 'a'.repeat(40),
    check: 'Unit tests',
    conclusion: 'failure',
    required: true,
    durationMs: 23_000,
    output:
      'FAIL test/money.test.ts\n  env: ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop\n  token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    annotations: [
      { path: 'test/money.test.ts', message: '"pounds > writes 5 pence as £0.05" was deleted' },
      { path: 'test/env.test.ts', message: '"reads token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" was deleted' },
    ],
  },
  artifacts: [],
};

/**
 * A dependency's move, invented: an image no registry holds, from its tag to a tag with its digest, on two lines, with
 * advisories no publisher wrote (a GHSA id uses none of 0 and 1, and 2099 has no CVEs yet).
 */
export const MOVE: NonNullable<PayloadOf<'signal.received'>['move']> = {
  repository: 'the-roganator/cv-worlds-worst-website',
  name: 'ghcr.io/invented/base',
  ecosystem: 'docker',
  from: '1.4.2-slim',
  to: `1.4.3-slim@sha256:${'c'.repeat(64)}`,
  pins: [
    { file: 'Dockerfile', line: 1 },
    { file: 'Dockerfile', line: 14 },
  ],
};

export const dependencySignal: NewEvent<'signal.received'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
  ts: '2026-11-11T06:00:00.000Z',
  work_item: '1301',
  type: 'signal.received',
  version: 6,
  actor: 'dependency',
  summary: 'ghcr.io/invented/base moves from 1.4.2-slim, clearing a High',
  payload: {
    sense: 'dependency',
    check: 'vulnerabilities',
    move: MOVE,
    version: 'd487739',
    symptom: 'vulnerable-dependency',
    evidence: [
      {
        kind: 'scan',
        findings: [
          {
            advisory: 'CVE-2099-0001',
            package: 'libinvented',
            severity: { scanner: 'high', publisher: 'medium' },
            fixed: '2.1.1',
            deadline: '2026-11-18T06:00:00.000Z',
          },
          { advisory: 'GHSA-0000-0000-0001', package: 'libinvented', severity: { scanner: 'low' } },
        ],
        rest: { critical: 0, high: 0, medium: 3, low: 11, unknown: 2 },
      },
    ],
  },
  artifacts: [],
};

export const dependencyTicket: NewEvent<'ticket.opened'> = {
  ...dependencySignal,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61',
  type: 'ticket.opened',
  version: 3,
  actor: 'triage',
  summary: 'Ticket #1301: security, broken',
  payload: {
    title: 'Move ghcr.io/invented/base, in docker',
    category: 'security',
    severity: 'broken',
    fingerprint: { name: 'ghcr.io/invented/base', ecosystem: 'docker' },
    traces: [],
  },
};

export const dependencyOpened: NewEvent<'work-item.opened'> = {
  ...dependencySignal,
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a62',
  type: 'work-item.opened',
  version: 3,
  actor: 'triage',
  summary: 'The dependency sense opened a work item',
  payload: {
    kind: 'dependency-update',
    title: 'Move ghcr.io/invented/base, in docker',
    sample: false,
    category: 'security',
    dependency: { name: MOVE.name, ecosystem: 'docker', from: MOVE.from, to: MOVE.to, security: true },
  },
};
