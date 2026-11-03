/**
 * The red-team attacks' test data (`events.ts`): up to date, valid, and carrying the role that would append each event,
 * as the store would let it, so the console's tests of an attack read what a real one would record.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PublicEvent, VERSIONS } from '@software-factory/events';
import { formatLog } from '@software-factory/events/log';
import { describe, expect, it } from 'vitest';
import { mayAppend } from '../../../../policy/refusals.ts';
import { STORE_GRANTS } from '../../../../policy/store-grants.ts';
import { LOG, publicAttacks } from './export.ts';

const published = publicAttacks();
const of = <K extends PublicEvent['type']>(type: K) =>
  published.filter((event): event is PublicEvent<K> => event.type === type);

describe('the attacks’ test data', () => {
  it('is up to date: node apps/console/test/attacks/export.ts writes it', () => {
    expect(readFileSync(join(LOG, 'events.ndjson'), 'utf-8')).toBe(formatLog(published));
  });

  it('holds three of the five attacks, one in flight, one not refused, each event at its current version', () => {
    expect(of('attack.launched').map((event) => [event.work_item, event.payload.attack])).toEqual([
      ['1289', 'report'],
      ['1293', 'image'],
      ['1333', 'egress'],
      ['1335', 'image'],
    ]);
    expect(of('attack.finished').map((event) => [event.work_item, event.payload.outcome])).toEqual([
      ['1289', 'refused'],
      ['1293', 'refused'],
      ['1333', 'not-refused'],
    ]);
    for (const event of published) expect(event.version, event.type).toBe(VERSIONS[event.type]);
  });

  it('carries the role that would append each, as the store would let it', () => {
    const roles = new Set(Object.keys(STORE_GRANTS));
    for (const event of published) {
      expect(roles.has(event.appended_by ?? ''), `${event.work_item} ${event.type}`).toBe(true);
      if (event.type === 'action.refused') {
        expect(mayAppend(event.payload.mechanism, event.appended_by ?? ''), event.payload.mechanism).toBe(true);
      }
    }
    // Martin launches; the harness alone ends an attack and closes its work item.
    expect(new Set(of('attack.launched').map((event) => event.appended_by))).toEqual(new Set(['factory_admin']));
    expect(new Set(of('attack.finished').map((event) => event.appended_by))).toEqual(new Set(['factory_redteam']));
    for (const end of of('attack.finished')) {
      const close = of('work-item.closed').find((event) => event.work_item === end.work_item);
      expect(close?.appended_by).toBe('factory_redteam');
    }
    // Triage records its quarantine, the line admission control's refusal, and the harness the egress attack's own.
    expect(
      Object.fromEntries(
        Object.entries(Object.groupBy(of('action.refused'), (event) => event.payload.mechanism)).map(
          ([mechanism, list]) => [mechanism, [...new Set(list?.map((event) => event.appended_by))]],
        ),
      ),
    ).toEqual({
      'typed-judgement': ['factory_triage'],
      'admission-control': ['factory_line'],
      'egress-policy': ['factory_redteam'],
    });
  });

  it('ends each attack citing its refusals by their seqs in the log, as the store numbers them, after its launch', () => {
    for (const end of of('attack.finished')) {
      const launch = of('attack.launched').find((event) => event.work_item === end.work_item);
      const cited = end.payload.refusals.map((seq) => published.find((event) => event.seq === seq));
      expect(cited.map((event) => event?.type)).toEqual(end.payload.refusals.map(() => 'action.refused'));
      for (const event of cited) expect(event?.seq).toBeGreaterThan(launch?.seq ?? Infinity);
    }
  });
});
