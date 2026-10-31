/**
 * The `app-permissions` proof's judgement: each GitHub App installed in the organisation, read live with Martin's
 * `gh`, against what `scripts/github-settings.ts` declares of it (`APPS`). An installation holds as declared when it is
 * one of the Apps declared there and holds exactly the permissions declared for it; and none, declared or not, may
 * write Variables, Administration or Workflows, or the secrets and environments that would let it reach a key.
 */
import { APPS } from '../../../../scripts/github-settings.ts';

export interface Installation {
  app_slug: string;
  app_id: number;
  permissions: Record<string, string>;
  repository_selection?: string;
}

/** Permissions no App of ours may write: each would let it change what the gates read, or the rules themselves. */
export const NEVER_WRITTEN = [
  'actions_variables',
  'variables',
  'administration',
  'organization_administration',
  'workflows',
  'secrets',
  'environments',
] as const;

const listed = (permissions: Record<string, string>) =>
  Object.entries(permissions)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, level]) => `${name} ${level}`)
    .join(', ');

export function judgeInstallations(installations: Installation[]): { held: boolean; lines: string[] } {
  const declared = new Map<string, { permissions: Record<string, string> }>(
    Object.values(APPS).map((app) => [app.slug, app]),
  );
  const lines: string[] = [];
  let held = installations.length > 0;
  if (!installations.length) lines.push('✗ no installation was read');
  for (const installation of installations) {
    const live = installation.permissions ?? {};
    const problems: string[] = [];
    const app = declared.get(installation.app_slug);
    if (!app) problems.push('not an App scripts/github-settings.ts declares');
    else {
      for (const [name, level] of Object.entries(live)) {
        if (app.permissions[name] !== level) {
          problems.push(`${name} ${level}, declared ${app.permissions[name] ?? 'none'}`);
        }
      }
      for (const name of Object.keys(app.permissions)) if (!(name in live)) problems.push(`${name} not held`);
    }
    for (const name of NEVER_WRITTEN) if (live[name] === 'write') problems.push(`writes ${name}`);
    held &&= problems.length === 0;
    lines.push(
      `${problems.length ? '✗' : '✓'} ${installation.app_slug} (${installation.app_id}): ${listed(live)}${
        problems.length ? `: ${problems.join('; ')}` : ': as declared'
      }`,
    );
  }
  return { held, lines };
}
