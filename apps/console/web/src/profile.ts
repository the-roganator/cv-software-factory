/**
 * The factory the page shows, as its server says in the page's meta tags (`apps/console/src/site.ts`): the profile
 * whose policy bounds Martin's settings, whether the gateway sends every agent to the local model (`ALL_LOCAL`),
 * whatever the settings say, and the app's address (`APP_URL`), which a flag's "Preview it" opens. Anything unexpected
 * reads as the defaults: `local`, not, and no address.
 */
import { PAGE_PATH } from '@software-factory/events';
import { PROFILES, type Profile } from '@software-factory/policy/spend';

export interface Factory {
  profile: Profile;
  allLocal: boolean;
  /** The app's origin, when the server names one. */
  app: string | undefined;
}

/** The page, or as much of one as the meta tags are read from. */
interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function factoryOf(doc: Page = (globalThis as unknown as { document: Page }).document): Factory {
  const named = doc.querySelector('meta[name="sf-profile"]')?.getAttribute('content') ?? '';
  const profile = (PROFILES as readonly string[]).includes(named) ? (named as Profile) : 'local';
  return {
    profile,
    allLocal: doc.querySelector('meta[name="sf-all-local"]')?.getAttribute('content') === 'true',
    app: appOrigin(doc.querySelector('meta[name="sf-app"]')?.getAttribute('content') ?? ''),
  };
}

/** An http or https origin, as a link may take it, or none. */
function appOrigin(given: string): string | undefined {
  try {
    const url = new URL(given);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where "Preview it on the app" goes: the page the flag's spec changes first, or the front page when it names none, or
 * names one that is not a path alone (`PAGE_PATH`, as `spec.written` holds it), asking for the flag's preview, which
 * sets its cookie.
 */
export const previewHref = (app: string, flag: string, page = '/') =>
  `${app}${PAGE_PATH.test(page) ? page : '/'}?${new URLSearchParams({ preview: flag })}`;
