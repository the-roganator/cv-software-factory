import { describe, expect, it } from 'vitest';
import type { Exception } from '../../../../policy/vulnerabilities.ts';
import { allowed, githubLookup, type Lookup } from '../../src/gates/dependency-allow.ts';
import { lockfileEntries, ownImage } from '../../src/gates/exceptions.ts';
import { newIn } from '../../src/gates/image-scan.ts';
import { except, type Finding } from '../../src/gates/lockfile-scan.ts';

/**
 * The app's three dependency gates over one fixture policy, of invented entries: what an entry in force excepts, the
 * lockfile scan, the image scan and dependency review agree on, and an expired entry, or one for another item or
 * repository, excepts nothing in any of them.
 */
const APP = 'the-roganator/cv-worlds-worst-website';
const FACTORY = 'the-roganator/cv-software-factory';
const TODAY = '2026-11-11';
const PACKAGE = 'invented-pkg';
const CVE = 'CVE-2099-20001';
const GHSA = 'GHSA-2222-3333-4444';

const entry = (over: Partial<Exception> = {}): Exception => ({
  repository: APP,
  item: 'pnpm-lock.yaml',
  advisory: CVE,
  package: PACKAGE,
  reason: 'An invented drill entry.',
  expires: '2026-11-12',
  ...over,
});

/** The fixture policy, each entry the same finding but for what the test names. */
const IN_FORCE = [entry(), entry({ item: ownImage(APP) })];
const EXPIRED = [entry({ expires: '2026-11-10' }), entry({ item: ownImage(APP), expires: '2026-11-10' })];
const OTHER_ITEM = [entry({ item: 'tools/pnpm-lock.yaml' }), entry({ item: 'ghcr.io/the-roganator/other' })];
const OTHER_REPOSITORY = [entry({ repository: FACTORY }), entry({ repository: FACTORY, item: ownImage(APP) })];

const lockfileFinding: Finding = {
  lockfile: 'pnpm-lock.yaml',
  advisory: CVE,
  pkg: PACKAGE,
  version: '1.2.3',
  dev: true,
  severity: 'CRITICAL',
  fixed: '1.2.4',
  title: '',
};
const report = (...vulns: { VulnerabilityID: string; PkgName: string }[]) => ({
  SchemaVersion: 2,
  Results: [
    {
      Target: 'app/node_modules',
      Vulnerabilities: vulns.map((v) => ({ ...v, InstalledVersion: '1.2.3', Severity: 'CRITICAL' })),
    },
  ],
});
const imageBase = report();
const imageChange = report({ VulnerabilityID: CVE, PkgName: PACKAGE });

/** GitHub's advisory database, as far as the fixture goes: the CVE is the GHSA, for the package alone. */
const lookup: Lookup = async (advisory, pkg) =>
  (advisory === CVE || advisory === GHSA) && pkg === PACKAGE ? [GHSA] : [];

/** What each gate makes of the finding under the entries given. */
async function gates(entries: Exception[]) {
  return {
    lockfile: except([lockfileFinding], APP, entries, TODAY).failing.length === 0,
    image: newIn(imageBase, imageChange, APP, entries, TODAY).failing.length === 0,
    review: (await allowed(APP, lookup, entries, TODAY)).ghsas.includes(GHSA),
  };
}

describe("the app's dependency gates, over one policy", () => {
  it('each except the finding an entry in force names, in the lockfile and in the image', async () => {
    expect(await gates(IN_FORCE)).toEqual({ lockfile: true, image: true, review: true });
    const { excepted } = newIn(imageBase, imageChange, APP, IN_FORCE, TODAY);
    expect(excepted.map((v) => [v.VulnerabilityID, v.expires])).toEqual([[CVE, '2026-11-12']]);
  });

  it('none excepts it once the entries have expired', async () => {
    expect(await gates(EXPIRED)).toEqual({ lockfile: false, image: false, review: false });
    // In force on its last day, and not the day after.
    expect((await allowed(APP, lookup, IN_FORCE, '2026-11-12')).ghsas).toEqual([GHSA]);
    expect((await allowed(APP, lookup, IN_FORCE, '2026-11-13')).ghsas).toEqual([]);
  });

  it('none excepts it by an entry for another item', async () => {
    const other = await gates(OTHER_ITEM);
    expect([other.lockfile, other.image]).toEqual([false, false]);
    // Dependency review allows an advisory across the change's lockfiles: it is given every lockfile's entries, and
    // the lockfile scan beside it holds each to its own. An image's entry allows nothing there.
    expect((await allowed(APP, lookup, [entry({ item: ownImage(APP) })], TODAY)).ghsas).toEqual([]);
  });

  it('none excepts it by an entry for another repository, or by none', async () => {
    expect(await gates(OTHER_REPOSITORY)).toEqual({ lockfile: false, image: false, review: false });
    const unnamed = {
      lockfile: except([lockfileFinding], '', IN_FORCE, TODAY).failing.length,
      image: newIn(imageBase, imageChange, '', IN_FORCE, TODAY).failing.length,
      review: (await allowed('', lookup, IN_FORCE, TODAY)).ghsas.length,
    };
    expect(unnamed).toEqual({ lockfile: 1, image: 1, review: 0 });
  });

  it('none excepts another package or advisory', async () => {
    const other = [entry({ package: 'another-pkg' }), entry({ item: ownImage(APP), advisory: 'CVE-2099-20002' })];
    expect(await gates(other)).toEqual({ lockfile: false, image: false, review: false });
  });

  it("names the app's own image as its list does, by the repository, whatever case", () => {
    expect(ownImage('The-Roganator/CV-Worlds-Worst-Website')).toBe('ghcr.io/the-roganator/cv-worlds-worst-website');
    // With a digest, an entry is the same image's.
    const pinned = [entry({ item: `${ownImage(APP)}@sha256:${'b'.repeat(64)}` })];
    expect(newIn(imageBase, imageChange, APP, pinned, TODAY).failing).toEqual([]);
  });

  it("gives dependency review only lockfiles' entries in force", () => {
    expect(lockfileEntries(APP, [...IN_FORCE, ...EXPIRED, ...OTHER_REPOSITORY], TODAY)).toEqual([IN_FORCE[0]]);
  });
});

describe("dependency review's advisories", () => {
  it('are the GHSA ids the database holds for each entry, and an entry it holds none for is named', async () => {
    const entries = [entry(), entry({ advisory: GHSA }), entry({ package: 'unknown-pkg' })];
    const { ghsas, used, unknown } = await allowed(APP, lookup, entries, TODAY);
    expect(ghsas).toEqual([GHSA]);
    expect(used).toHaveLength(2);
    expect(unknown).toEqual([entries[2]]);
  });

  it('take only what GitHub writes as a GHSA id, so nothing else reaches the action', async () => {
    const odd: Lookup = async () => ['GHSA-2222-3333-4444,GHSA-xxxx', 'not an id', GHSA];
    expect((await allowed(APP, odd, [entry()], TODAY)).ghsas).toEqual([GHSA]);
  });

  it('ask the database by the entry’s id, its package and npm, and give up after three tries', async () => {
    const asked: string[] = [];
    const answers = [new Response('no', { status: 502 }), Response.json([{ ghsa_id: GHSA }])];
    const fetcher = (async (url: string, init: RequestInit) => {
      asked.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return answers.shift() ?? new Response('no', { status: 500 });
    }) as unknown as typeof fetch;
    expect(await githubLookup('token', fetcher)(CVE, '@scope/pkg')).toEqual([GHSA]);
    expect(asked).toEqual([
      `https://api.github.com/advisories?cve_id=${CVE}&ecosystem=npm&affects=%40scope%2Fpkg&per_page=100 Bearer token`,
      `https://api.github.com/advisories?cve_id=${CVE}&ecosystem=npm&affects=%40scope%2Fpkg&per_page=100 Bearer token`,
    ]);
    asked.length = 0;
    await expect(githubLookup(undefined, fetcher)(GHSA, PACKAGE)).rejects.toThrow(/could not be read.*500/);
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain(`ghsa_id=${GHSA}`);
  });
});
