/**
 * The scratch cluster's own GitHub App, made once through GitHub's manifest flow: `./copies.sh app`.
 *
 * Serves http://127.0.0.1:3999 on the Mac alone. Its page posts the manifest to the organisation; Martin presses
 * "Create GitHub App", GitHub sends him back here with a one-hour code, and this trades the code for the App's
 * identity and private key. The key goes to the Keychain as `scratch-factory-github-app-key` (base64, as the real
 * one's is), through `security -i` on stdin, never a file or a command line. The identity, which is public, goes to
 * app.env, which copies.sh's build writes into the copies' code. Then it says where to install the App: on the two
 * copies alone.
 *
 * The permissions are the real factory App's (APPS.factory in scripts/github-settings.ts), and nothing more.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const ORG = 'the-roganator';
const NAME = 'the-roganator-scratch-factory';
const KEYCHAIN = 'scratch-factory-github-app-key';
const PORT = 3999;
const HERE = import.meta.dirname;
const state = randomBytes(16).toString('hex');

const manifest = {
  name: NAME,
  url: `https://github.com/${ORG}/cv-software-factory-scratch`,
  description: "The scratch cluster's factory, for the patching tests. Installed on the two scratch copies alone.",
  hook_attributes: { url: `https://github.com/${ORG}/cv-software-factory-scratch`, active: false },
  redirect_url: `http://127.0.0.1:${PORT}/callback`,
  public: false,
  default_permissions: {
    actions: 'read',
    checks: 'write',
    contents: 'write',
    issues: 'write',
    metadata: 'read',
    pull_requests: 'write',
    security_events: 'read',
  },
  default_events: [],
};

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const page = `<!doctype html><meta charset="utf-8"><title>Scratch App</title>
<body style="font: 16px system-ui; margin: 3em">
<p>This makes <b>${NAME}</b> in ${ORG}, with the real factory App's permissions and no webhook.</p>
<form method="post" action="https://github.com/organizations/${ORG}/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button style="font-size: 1.2em">Continue to GitHub</button></form>`;

const keychain = (pem: string) => {
  const b64 = Buffer.from(pem).toString('base64');
  const account = process.env.USER ?? 'scratch';
  // -U replaces one made before. security -i reads the command from stdin, so the key is on no command line.
  const r = spawnSync('security', ['-i'], {
    input: `add-generic-password -U -s ${KEYCHAIN} -a ${account} -w ${b64}\n`,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`security failed: ${r.stderr}`);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    return;
  }
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state does not match: start again from /');
    const code = url.searchParams.get('code');
    if (!code || !/^[0-9a-f]+$/i.test(code)) throw new Error('no code');
    const made = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'scratch-copies' },
    });
    if (!made.ok) throw new Error(`conversion: ${made.status} ${await made.text()}`);
    const app = (await made.json()) as { id: number; slug: string; client_id: string; pem: string };
    keychain(app.pem);
    const bot = await fetch(`https://api.github.com/users/${encodeURIComponent(`${app.slug}[bot]`)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'scratch-copies' },
    });
    if (!bot.ok) throw new Error(`bot user: ${bot.status}`);
    const { id: botId } = (await bot.json()) as { id: number };
    writeFileSync(
      join(HERE, '..', 'app.env'),
      [
        `# The scratch cluster's GitHub App (app.ts, ${new Date().toISOString()}). Its key: the Keychain's ${KEYCHAIN}.`,
        `SCRATCH_APP_SLUG=${app.slug}`,
        `SCRATCH_APP_ID=${app.id}`,
        `SCRATCH_APP_CLIENT_ID=${app.client_id}`,
        `SCRATCH_APP_BOT_ID=${botId}`,
        '',
      ].join('\n'),
    );
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><meta charset="utf-8"><body style="font: 16px system-ui; margin: 3em">
<p>Made <b>${app.slug}</b> (App ${app.id}, bot user ${botId}); its key is in the Keychain as ${KEYCHAIN}.</p>
<p>Now <a href="${install}">install it</a> on <b>${ORG}</b>, choosing <b>Only select repositories</b>:
cv-software-factory-scratch and cv-worlds-worst-website-scratch, and nothing else.</p>`,
    );
    console.log(`made ${app.slug} (id ${app.id}, client ${app.client_id}, bot ${botId}); install: ${install}`);
    server.close();
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e));
    console.error(String(e));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`open http://127.0.0.1:${PORT}/ and press Continue, then "Create GitHub App"`);
  spawnSync('open', [`http://127.0.0.1:${PORT}/`]);
});
