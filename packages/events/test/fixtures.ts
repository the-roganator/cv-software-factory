/**
 * A few hand-made events for the tests: one work item, from a visitor's report to its judgement.
 */
import type { NewEvent } from '../src/types.ts';

export const REPORT_TEXT = 'the clock on item 2 says ten past four all day, is it broken?';
export const VISITOR_KEY = 'amber-otter';
const CASSETTE = 'c0ffee'.padEnd(64, '0');

export const opened: NewEvent<'work-item.opened'> = {
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  ts: '2026-10-02T12:15:00.000Z',
  work_item: '1284',
  type: 'work-item.opened',
  version: 2,
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
  version: 5,
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
  version: 2,
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
