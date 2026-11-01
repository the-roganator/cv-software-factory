/**
 * The one way Martin's writes go (`web/src/write.ts`, which `useWrite` draws): busy while one is under way, the
 * passkey asked for in a dialog of its own or proved within the dialog that is open, and what came back said. The
 * admin service is a stand-in for `fetch`; the passkey's ways are stand-ins for `StepUp.tsx`'s. Then the reason field
 * every write that asks for words draws (`Words.tsx`).
 */
import { MARTIN_REASON_CHARS, REQUEST_WORDS } from '@software-factory/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asked } from '../src/components/StepUp.tsx';
import { ReasonField } from '../src/components/Words.tsx';
import { type WriterDeps, type WriteState, writer } from '../src/write.ts';

/** What the stand-in service answers, in order, and each request it was sent. */
let answers: { status: number; body?: Record<string, unknown> }[];
let sent: { path: string; body: unknown; token: string | null }[];

beforeEach(() => {
  answers = [];
  sent = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    sent.push({
      path,
      body: JSON.parse(String(init.body)),
      token: new Headers(init.headers).get('x-csrf-token'),
    });
    const answer = answers.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

const STEP_UP = { status: 403, body: { refused: 'step-up', message: 'This needs your passkey again.' } };
const ASKED: Asked = { title: 'Promote the canary', what: 'v2 takes all the traffic now.', why: 'Promoting ships' };

/** A writer with its state recorded, a session, a page that stays, and passkey ways that say what they are told. */
function make(over: Partial<WriterDeps> & { asks?: boolean[]; proves?: (string | undefined)[] } = {}) {
  const shown: WriteState[] = [];
  const asked: Asked[] = [];
  let proved = 0;
  const w = writer({
    token: () => 'token-1',
    live: () => true,
    show: (state) => shown.push(state),
    stepUp: () => ({
      ask: async (a) => {
        asked.push(a);
        return over.asks?.shift() ?? true;
      },
      prove: async () => {
        proved += 1;
        return over.proves?.shift();
      },
    }),
    ...over,
  });
  return { w, shown, asked, proved: () => proved };
}

describe('a write', () => {
  it('is busy while under way, and sends the session’s token', async () => {
    const { w, shown } = make();
    const written = await w.send('/admin/line/controls', { newWork: false });
    expect(written.kind).toBe('done');
    expect(shown).toEqual([
      { busy: true, refusal: undefined },
      { busy: false, refusal: undefined },
    ]);
    expect(sent).toEqual([{ path: '/admin/line/controls', body: { newWork: false }, token: 'token-1' }]);
  });

  it('sends nothing while one is under way, or with no session', async () => {
    const { w } = make();
    const first = w.send('/admin/line/controls', { newWork: false });
    expect((await w.send('/admin/line/controls', { newWork: true })).kind).toBe('unsent');
    await first;
    expect(sent).toHaveLength(1);
    const visitor = make({ token: () => undefined });
    expect((await visitor.w.send('/admin/line/controls', {})).kind).toBe('unsent');
    expect(visitor.shown).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('says the service’s refusal in its own words, or the write’s, and clears it at the next', async () => {
    const { w, shown } = make();
    answers.push({ status: 409, body: { refused: 'line', message: 'The line is stopped already.' } });
    const written = await w.send('/admin/line/stop', { reason: 'why' });
    expect(written).toMatchObject({ kind: 'refused', text: 'The line is stopped already.' });
    expect(shown.at(-1)).toEqual({ busy: false, refusal: 'The line is stopped already.' });

    answers.push({ status: 502, body: { refused: 'kubernetes', message: 'Kubernetes refused.' } });
    await w.send('/admin/flags/f/stage', {}, { words: (got) => `${got.status}: nothing was done.` });
    expect(shown.at(-1)?.refusal).toBe('502: nothing was done.');

    await w.send('/admin/flags/f/stage', {});
    expect(shown.at(-2)).toEqual({ busy: true, refusal: undefined });
    expect(shown.at(-1)).toEqual({ busy: false, refusal: undefined });
  });

  it('says ours when the service can’t be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const { w, shown } = make();
    await w.send('/admin/settings', {});
    expect(shown.at(-1)?.refusal).toBe('The admin service can’t be reached. Try again in a moment.');
  });

  it('says what the write made says of itself, drawn with it, and takes what it accepts as made', async () => {
    const { w, shown } = make();
    answers.push({ status: 200, body: { warning: 'The canary in flight was not aborted.' } });
    let closed = false;
    await w.send(
      '/admin/line/stop',
      {},
      {
        done: (got) => {
          closed = true;
          return typeof got.body?.warning === 'string' ? got.body.warning : undefined;
        },
      },
    );
    expect(closed).toBe(true);
    expect(shown.at(-1)).toEqual({ busy: false, refusal: 'The canary in flight was not aborted.' });

    answers.push({ status: 409, body: { refused: 'request', message: 'Made already.' } });
    const made = await w.send('/admin/improvements', {}, { accept: (got) => got.status === 409 });
    expect(made.kind).toBe('done');
    expect(shown.at(-1)).toEqual({ busy: false, refusal: undefined });
  });

  it('can be cleared or said to from outside', () => {
    const { w, shown } = make();
    w.say('Something left undone.');
    w.say(undefined);
    expect(shown).toEqual([
      { busy: false, refusal: 'Something left undone.' },
      { busy: false, refusal: undefined },
    ]);
  });
});

describe('the passkey asked in a dialog of its own', () => {
  it('is asked when the service asks, and the write sent again once given', async () => {
    const { w, asked } = make({ asks: [true] });
    answers.push(STEP_UP, { status: 200 });
    const written = await w.send('/admin/release/promote', { release: 'r1' }, { passkey: ASKED });
    expect(written.kind).toBe('done');
    expect(asked).toEqual([ASKED]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('cancelled, sends nothing more and says nothing', async () => {
    const { w, shown } = make({ asks: [false] });
    answers.push(STEP_UP);
    expect((await w.send('/admin/release/promote', {}, { passkey: ASKED })).kind).toBe('cancelled');
    expect(sent).toHaveLength(1);
    expect(shown.at(-1)).toEqual({ busy: false, refusal: undefined });
  });

  it('is never asked when the service does not ask', async () => {
    const { w, asked } = make();
    await w.send('/admin/release/promote', {}, { passkey: ASKED });
    expect(asked).toEqual([]);
  });

  it('with no way to ask, the service’s refusal stands', async () => {
    const { w, asked, shown } = make();
    answers.push(STEP_UP);
    expect((await w.send('/admin/release/abort', {})).kind).toBe('refused');
    expect(asked).toEqual([]);
    expect(shown.at(-1)?.refusal).toBe('This needs your passkey again.');
  });
});

describe('the passkey proved within the dialog that is open', () => {
  it('runs the browser’s sheet when the service asks, and sends again once given', async () => {
    const { w, proved, asked } = make({ proves: [undefined] });
    answers.push(STEP_UP, { status: 200 });
    expect((await w.send('/admin/line/start', { reason: 'why' }, { passkey: 'prove' })).kind).toBe('done');
    expect(proved()).toBe(1);
    expect(asked).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('not given, says why in the dialog, and sends nothing more', async () => {
    const { w, shown } = make({ proves: ['No passkey was used.'] });
    answers.push(STEP_UP);
    const written = await w.send('/admin/line/start', {}, { passkey: 'prove' });
    expect(written).toMatchObject({ kind: 'refused', text: 'No passkey was used.' });
    expect(shown.at(-1)?.refusal).toBe('No passkey was used.');
    expect(sent).toHaveLength(1);
  });

  it('closed while it asked, sends nothing more and draws nothing', async () => {
    let live = true;
    const { w, shown } = make({
      live: () => live,
      stepUp: () => ({
        ask: async () => true,
        prove: async () => {
          live = false;
          return undefined;
        },
      }),
    });
    answers.push(STEP_UP);
    expect((await w.send('/admin/line/start', {}, { passkey: 'prove' })).kind).toBe('gone');
    expect(sent).toHaveLength(1);
    expect(shown).toEqual([{ busy: true, refusal: undefined }]);
  });
});

describe('the reason field', () => {
  /** The elements a component draws, by tag, from the tree it returns. */
  const elements = (node: unknown, tag: string): { props: Record<string, unknown> }[] => {
    if (Array.isArray(node)) return node.flatMap((child) => elements(child, tag));
    if (!node || typeof node !== 'object' || !('props' in node)) return [];
    const vnode = node as { type: unknown; props: Record<string, unknown> };
    return [...(vnode.type === tag ? [vnode] : []), ...elements(vnode.props.children, tag)];
  };
  const field = (props: Partial<Parameters<typeof ReasonField>[0]>) =>
    ReasonField({
      id: 'r',
      label: 'Reason',
      value: 'Paused',
      onChange: () => {},
      placeholder: 'Why',
      help: 'Seen',
      ...props,
    });

  it('takes a reason’s limit from the events package, and counts against it', () => {
    const tree = field({});
    expect(elements(tree, 'textarea')[0]?.props.maxLength).toBe(MARTIN_REASON_CHARS);
    const chars = elements(tree, 'span').find((span) => span.props.className === 'chars');
    expect(chars?.props.children).toEqual([6, ' / ', MARTIN_REASON_CHARS]);
  });

  it('takes words with a limit of their own', () => {
    const tree = field({ limit: REQUEST_WORDS });
    expect(elements(tree, 'textarea')[0]?.props.maxLength).toBe(REQUEST_WORDS);
  });

  it('shares a row with what it is sent by, when it has one', () => {
    expect(elements(field({}), 'div')).toEqual([]);
    expect(elements(field({ children: 'Send' }), 'div')[0]?.props.className).toBe('row');
  });
});
