/**
 * The admin service's settings, from its environment. Everything a check compares a request with comes from here and
 * never from the request: the console's origin, which `Origin` must match exactly and WebAuthn's ceremonies must name,
 * the relying party a passkey belongs to, and the proxies whose forwarded headers are believed.
 *
 * - ADMIN_ORIGIN: the console's origin as the browser sees it, such as `https://console.localhost:8443`. Required, and
 *   `https` but for `localhost` itself, as WebAuthn requires.
 * - ADMIN_RP_ID: the relying party's id, a passkey's host; by default the origin's host name.
 * - ADMIN_TRUSTED_PROXIES: the addresses, or CIDR ranges, of the proxy in front (Traefik's, locally), comma-separated.
 *   `X-Forwarded-For` is believed from these alone; with none, it never is.
 * - RELEASE_ROLLOUT: the app's Rollout, as `<namespace>/<name>`, as the line is given it: the one the Canary panel's
 *   controls change, through the admin service's own Role (deploy/base/analysis/admin-controls-release.yaml). Unset,
 *   the controls are refused, and nothing here reaches Kubernetes.
 * - FEATURE_FLAGS: the FeatureFlag flagd watches, as `<namespace>/<name>` (`flagd/flags`): the one Martin's stages are
 *   written to, through the admin service's own Role (deploy/base/flagd/admin-stages-flags.yaml). Unset, every move of
 *   a flag is refused. Moving a flag into Share reads RELEASE_ROLLOUT's canary too, and without it is refused.
 * - FACTORY_PROFILE: local, do or aws (default local), as the gateway's and the line's: the bounds Martin's settings
 *   are held to (`policy/settings.ts`), and their defaults, and whether alerts reach his phone before he switches them
 *   (`policy/phone.ts`).
 * - GRAFANA_URL, ARGOCD_URL: this deployment's Grafana and Argo CD, each an http or https address, which Martin's
 *   session names so his account menu links to them. Only a signed-in session is told them: a public deployment's
 *   internal hosts never reach a visitor's page. Unset, the menu has no link to that tool.
 * - PORT: where it listens (8080).
 */
import { BlockList, isIP } from 'node:net';
import type { Attack } from '@software-factory/events';
import { PROFILES, type Profile } from '../../../../policy/spend.ts';
import { type RolloutRef, rolloutRefOf } from '../release/rollout-ref.ts';

export interface AdminConfig {
  origin: string;
  rpId: string;
  /** Whether a connection comes from the proxy in front, whose forwarded headers are believed. */
  trusted: BlockList;
  port: number;
  /** The app's Rollout, which the release controls change; none, and they are refused. */
  rollout?: RolloutRef;
  /** The FeatureFlag Martin's stages are written to; none, and every move is refused. */
  flags?: RolloutRef;
  /** The profile whose policy Martin's settings are held to, and whose default says whether alerts reach his phone. */
  profile: Profile;
  /** This deployment's tools, for Martin's account menu. */
  tools?: Tools;
  /**
   * Which attacks may be launched: `attackAvailable` (`policy/attacks.ts`) unless given. No setting reads it, so the
   * service in a cluster always holds to the catalogue; the tests give one to launch attacks the catalogue holds back.
   */
  attackAvailable?: (attack: Attack) => boolean;
}

/** The deployment's tools Martin's account menu links to, each when it is set. */
export interface Tools {
  grafana?: string;
  argocd?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv): AdminConfig {
  const given = env.ADMIN_ORIGIN;
  if (!given) throw new Error("Set ADMIN_ORIGIN to the console's origin, such as https://console.localhost:8443.");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`ADMIN_ORIGIN is not a URL: ${given}`);
  }
  // Exactly an origin: a path, a query or a trailing slash would never match a browser's `Origin`.
  if (url.origin !== given) throw new Error(`ADMIN_ORIGIN is an origin alone, such as ${url.origin}: not ${given}`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error(`ADMIN_ORIGIN must be https: a passkey and a secure cookie need it (${given})`);
  }
  const rpId = env.ADMIN_RP_ID || url.hostname;
  // The relying party is the origin's host or a domain it is under, as WebAuthn allows.
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new Error(`ADMIN_RP_ID ${rpId} is not ${url.hostname} or a domain it is under`);
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT is not a port: ${env.PORT}`);
  const rollout = rolloutRefOf(env.RELEASE_ROLLOUT ?? '');
  if (rollout === undefined) {
    throw new Error(
      `RELEASE_ROLLOUT is ${JSON.stringify(env.RELEASE_ROLLOUT)}; it must be <namespace>/<name>, or unset.`,
    );
  }
  const flags = rolloutRefOf(env.FEATURE_FLAGS ?? '');
  if (flags === undefined) {
    throw new Error(`FEATURE_FLAGS is ${JSON.stringify(env.FEATURE_FLAGS)}; it must be <namespace>/<name>, or unset.`);
  }
  const profile = (env.FACTORY_PROFILE || 'local').trim() as Profile;
  if (!PROFILES.includes(profile)) {
    throw new Error(`FACTORY_PROFILE is ${JSON.stringify(profile)}; it must be one of ${PROFILES.join(', ')}.`);
  }
  const grafana = toolUrl('GRAFANA_URL', env.GRAFANA_URL);
  const argocd = toolUrl('ARGOCD_URL', env.ARGOCD_URL);
  return {
    origin: url.origin,
    rpId,
    trusted: proxies(env.ADMIN_TRUSTED_PROXIES ?? ''),
    port,
    profile,
    ...(rollout && { rollout }),
    ...(flags && { flags }),
    tools: { ...(grafana && { grafana }), ...(argocd && { argocd }) },
  };
}

/**
 * A tool's address, as a link takes it: http or https, nothing a page would run, and no credentials. Unset or empty,
 * there is none.
 */
function toolUrl(name: string, given: string | undefined): string | undefined {
  const value = given?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https address: ${value}`);
  }
  // A page shows the address, so it carries no name or password.
  if (url.username || url.password) throw new Error(`${name} must not hold a user name or password`);
  return url.href;
}

/** The proxies in front, as `10.42.0.0/16, 127.0.0.1`. */
export function proxies(list: string): BlockList {
  const blocks = new BlockList();
  for (const entry of list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`ADMIN_TRUSTED_PROXIES: ${entry} is not an address or a range`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
      blocks.addAddress(address, type);
      continue;
    }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      throw new Error(`ADMIN_TRUSTED_PROXIES: ${entry} has no valid prefix`);
    }
    blocks.addSubnet(address, prefix, type);
  }
  return blocks;
}
