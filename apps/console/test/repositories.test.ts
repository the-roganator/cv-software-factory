import { describe, expect, it } from 'vitest';
import { REAL } from '../../../policy/repositories.ts';
import { repositoriesOf } from '../web/src/repositories.ts';

/** A page whose meta tags say these, and no others. */
const page = (meta: Record<string, string>) => ({
  querySelector(selector: string) {
    const name = /name="([^"]+)"/.exec(selector)?.[1] ?? '';
    return name in meta ? { getAttribute: () => meta[name] ?? null } : null;
  },
});

describe('the two repositories, as the page reads them', () => {
  it('takes the ones its server names, and the real two where it names none, as the replay site does', () => {
    const copies = { factory: 'the-roganator/scratch-factory', app: 'the-roganator/scratch-app' };
    expect(repositoriesOf(page({ 'sf-factory-repository': copies.factory, 'sf-app-repository': copies.app }))).toEqual(
      copies,
    );
    expect(repositoriesOf(page({ 'sf-factory-repository': '', 'sf-app-repository': '' }))).toEqual(REAL);
    expect(repositoriesOf(page({}))).toEqual(REAL);
    expect(repositoriesOf(undefined)).toEqual(REAL);
  });

  it('reads a name that is not one as the real two, never half of one', () => {
    expect(
      repositoriesOf(page({ 'sf-factory-repository': 'the-roganator/scratch-factory', 'sf-app-repository': 'x"><b>' })),
    ).toEqual(REAL);
  });
});
