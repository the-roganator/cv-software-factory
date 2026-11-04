/** Fakes for the red-team harness's unit tests: a store that answers canned rows, an event writer that hands back
 * seqs, and a logger that keeps quiet. No cluster and no Postgres: the attempts' logic is tested from their inputs. */
import type { NewEvent, StoredEvent } from '@software-factory/events';
import type { Logger } from '../../src/log.ts';

/** A `sql` tagged-template fake: `answer` sees the query (its text joined by `?`) and its parameters. */
export function fakeSql(answer: (query: string, params: unknown[]) => Record<string, unknown>[]) {
  // Called as a tag, it answers; called with a name (`sql('l.sample')`, as a fragment such as `byMartin` names a
  // column), it gives the name back, so a fragment in a query reads as its text.
  const sql = (strings: TemplateStringsArray | string, ...params: unknown[]): unknown =>
    typeof strings === 'string' ? strings : Promise.resolve(answer(strings.join('?'), params));
  return sql as unknown as import('postgres').Sql;
}

/** An event writer that gives each appended event a seq from `from`, and keeps what it was given. */
export function fakeEvents(from = 100) {
  const appended: NewEvent[] = [];
  let next = from;
  return {
    appended,
    append: async (events: NewEvent | readonly NewEvent[]): Promise<StoredEvent[]> => {
      const batch = Array.isArray(events) ? events : [events as NewEvent];
      return batch.map((event) => {
        appended.push(event);
        return { ...event, seq: next++ } as StoredEvent;
      });
    },
  };
}

export const silent: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

export const never: AbortSignal = new AbortController().signal;
