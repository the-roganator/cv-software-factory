/**
 * The full events, live, to Martin's session alone: the public stream's twin (`apps/console/src/stream.ts`), with
 * each event whole rather than its public view. Each event goes out with its seq as its ID, so a browser that loses
 * the connection resumes from the last it had.
 *
 * The session is checked again every few seconds, and the stream closes as soon as it is signed out, revoked or
 * expired: at once when this service ends it, and at the next check when `factory admin enrol --revoke-others` does,
 * or its hour runs out. It says why before it closes; the browser's next try is refused, and it stays closed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { listen, readFull } from '@software-factory/store';
import type { Sql } from 'postgres';
import type { Logger } from '../log.ts';
import type { AdminStore } from './store.ts';

/** How often an open stream checks its session is still live. */
export const RECHECK_MS = 5_000;

const HEARTBEAT_MS = 15_000;
/** How much may wait unsent for the browser before it is cut off, to resume from where it was. */
const MAX_BUFFERED_BYTES = 1 << 20;
const PAGE = 500;

interface Open {
  session: string;
  close(why: string): void;
}

/** Every full-event stream this service has open, told of each append through one LISTEN. */
export class FullEvents {
  readonly #sql: Sql;
  readonly #store: AdminStore;
  readonly #log: Logger;
  readonly #recheckMs: number;
  readonly #open = new Set<Open>();
  readonly #listeners = new Set<() => void>();
  #unlisten: (() => Promise<void>) | undefined;

  constructor(sql: Sql, store: AdminStore, log: Logger, recheckMs = RECHECK_MS) {
    this.#sql = sql;
    this.#store = store;
    this.#log = log;
    this.#recheckMs = recheckMs;
  }

  /** Starts listening for appends. */
  async start(): Promise<void> {
    const wake = () => {
      for (const listener of this.#listeners) listener();
    };
    const { unlisten } = await listen(this.#sql, wake, wake);
    this.#unlisten = unlisten;
  }

  /** Closes every stream and stops listening. */
  async stop(): Promise<void> {
    for (const open of [...this.#open]) open.close('stopping');
    await this.#unlisten?.();
  }

  /** Closes each stream of the sessions given, or of every session, saying why. */
  end(why: 'signed-out' | 'revoked', sessions?: readonly string[]): void {
    for (const open of [...this.#open]) if (!sessions || sessions.includes(open.session)) open.close(why);
  }

  get open(): number {
    return this.#open.size;
  }

  /** Streams every full event after `after` to a live session's browser, then each as it is appended. */
  stream(req: IncomingMessage, res: ServerResponse, session: string, after: number): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    // Closed by this service, or by the browser: nothing more may be written, though a read may still be in flight.
    let closed = false;
    const gone = () => closed || res.destroyed || res.writableEnded;
    let last = after;
    let reading: Promise<void> | undefined;
    let again = false;
    // One read at a time, and one more if an append arrived meanwhile.
    const catchUp = (): void => {
      if (reading) {
        again = true;
        return;
      }
      reading = (async () => {
        do {
          again = false;
          for (;;) {
            if (gone()) return;
            const page = await readFull(this.#sql, last, { limit: PAGE });
            for (const { event } of page) {
              if (gone()) return;
              last = event.seq;
              res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
              if (res.writableLength > MAX_BUFFERED_BYTES) {
                res.destroy();
                return;
              }
            }
            if (page.length < PAGE) break;
          }
        } while (again);
      })()
        .catch((error: unknown) => {
          this.#log.error({ err: error }, 'could not read the full events');
          res.destroy();
        })
        .finally(() => {
          reading = undefined;
        });
    };

    const heartbeat = setInterval(() => {
      if (!gone()) res.write(': still here\n\n');
    }, HEARTBEAT_MS);
    const recheck = setInterval(() => {
      this.#store.session(session).then(
        (live) => {
          if (!live) open.close('ended');
        },
        (error: unknown) => {
          // A session that cannot be checked is not believed.
          this.#log.error({ err: error }, 'could not check a full-event stream’s session');
          open.close('unchecked');
        },
      );
    }, this.#recheckMs);

    const open: Open = {
      session,
      close: (why) => {
        if (!gone()) res.end(`event: ended\ndata: ${JSON.stringify({ why })}\n\n`);
        cleanUp();
      },
    };
    const cleanUp = () => {
      closed = true;
      clearInterval(heartbeat);
      clearInterval(recheck);
      this.#listeners.delete(catchUp);
      this.#open.delete(open);
    };
    this.#open.add(open);
    this.#listeners.add(catchUp);
    res.once('close', cleanUp);
    req.once('aborted', () => res.destroy());
    catchUp();
  }
}

/** Where a browser resumes: the ID of the last event it had, or `?after=` on its first connection. */
export function resumeFrom(req: IncomingMessage, url: URL): number {
  const value = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  const seq = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}
