/**
 * The two repositories the factory looks after, as the page's server names them in its meta tags
 * (`apps/console/src/site.ts`, policy/repositories.ts): which rows are the app's, and where links to GitHub go. Blank or
 * not a name, as on the replay site or outside a page, each is the real one.
 */
import { REAL, type Repositories, repositoriesFrom } from '@software-factory/policy/repositories';

/** The page, or as much of one as the meta tags are read from. */
interface Page {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null;
}

export function repositoriesOf(doc: Page | undefined = (globalThis as { document?: Page }).document): Repositories {
  const meta = (name: string) => doc?.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined;
  try {
    return repositoriesFrom({
      FACTORY_REPOSITORY: meta('sf-factory-repository'),
      APP_REPOSITORY: meta('sf-app-repository'),
    });
  } catch {
    return REAL;
  }
}

export const REPOSITORIES = repositoriesOf();
