/**
 * The privacy page (`?view=privacy`), from the footer: what the console keeps on a visitor's device, which is nothing,
 * what the app keeps, which is its preview cookie for a browser that asks for one, and what its servers record. Every
 * claim here is held by something that fails when it stops being true: the browser tests' guard, the probes' `/device`
 * check, the collector's settings and their test, the backends' retention, and the days a report's text is kept, held
 * to triage's policy (docs/COMPONENTS/CONSOLE.md).
 */
import { useEffect } from 'react';
import { SESSION_MINUTES } from '../access.ts';
import { KEPT_DAYS, PREVIEW, TRIES_MINUTES } from '../privacy.ts';
import { REPORT_KEPT_DAYS } from '../projection/report.ts';
import '../styles/settings.css';
import '../styles/privacy.css';

const SOURCE = 'https://github.com/the-roganator/cv-software-factory/blob';

export function Privacy() {
  useEffect(() => {
    const was = document.title;
    document.title = 'Privacy · Software Factory';
    return () => {
      document.title = was;
    };
  }, []);

  return (
    <div className="privacy-page">
      <div className="privacy-head">
        <a className="crumb" href="/">
          ← The console
        </a>
        <h1>Privacy</h1>
        <p>
          The console keeps nothing on your device: no cookies and no tracking. There is nothing to agree to, so there
          is no banner.
        </p>
      </div>

      <section className="privacy-section" aria-labelledby="privacy-device">
        <h2 id="privacy-device">On your device</h2>
        <ul>
          <li>
            <strong>Nothing is stored.</strong> No cookies, no local storage, nothing that could know you next time.
            Every request goes to this site alone: nothing loads from anyone else’s.
          </li>
          <li>
            <strong>But Martin’s sign-in.</strong> When Martin signs in, his browser keeps one cookie,{' '}
            <code>__Host-session</code>, for {SESSION_MINUTES} minutes. It is strictly necessary to keep him signed in,
            holds a random number and nothing else, and goes to this site alone. A visitor never gets one.
          </li>
          <li>
            <strong>A preview of the app.</strong> The app keeps nothing on your device either, but for one cookie if
            you ask to preview a new feature, with <code>?preview=</code> and the feature’s name in its address. Then it
            keeps <code>{PREVIEW.cookie}</code>, for {PREVIEW.hours} hours from the last time you asked, to keep showing
            you the feature. It is strictly necessary to give you what you asked for, holds the names of the features
            asked for and nothing else, goes to the app alone, and no script can read it. To remove it, delete the app’s
            cookies in your browser’s settings, or wait {PREVIEW.hours} hours.
          </li>
          <li>
            <strong>Motion.</strong> The console reads your device’s <code>prefers-reduced-motion</code> setting to
            decide whether to animate, on your device: nothing is sent. Still, in the header, turns motion off for this
            visit, and <code>?motion=off</code> in the address from the start.
          </li>
        </ul>
      </section>

      <section className="privacy-section" aria-labelledby="privacy-server">
        <h2 id="privacy-server">What the server records</h2>
        <p>
          Like any web server, it records the requests it answers, to keep the site running and find what goes wrong.
        </p>
        <table className="privacy-kept">
          <thead className="label">
            <tr>
              <th scope="col">Record</th>
              <th scope="col">What it holds</th>
              <th scope="col">Kept for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Logs</th>
              <td>The page asked for, the answer’s status and how long it took, and any report you send</td>
              <td>{KEPT_DAYS.logs} days</td>
            </tr>
            <tr>
              <th scope="row">Traces</th>
              <td>How each request was answered, step by step</td>
              <td>{KEPT_DAYS.traces} days</td>
            </tr>
            <tr>
              <th scope="row">Metrics</th>
              <td>Counts and timings of all requests together, browsers among them</td>
              <td>Up to {KEPT_DAYS.metrics} days</td>
            </tr>
          </tbody>
        </table>
        <ul>
          <li>
            <strong>Your browser</strong> is recorded only as its family, its major version, its operating system and
            whether it is a phone or tablet or a computer: Chrome 141 on macOS, a computer. Never your address.
          </li>
          <li>
            <strong>A report you send</strong> is shown on the console only to Martin and to you, and its words are
            deleted, from the logs too, within {REPORT_KEPT_DAYS} days of their arrival.
          </li>
          <li>
            <strong>Signing in</strong> counts the tries from each address for {TRIES_MINUTES} minutes, in memory, so
            that nobody can guess at it. The address is never written down.
          </li>
        </ul>
      </section>

      <p className="privacy-proof">
        Each of these is checked, not promised: the console’s{' '}
        <a href={`${SOURCE}/main/apps/console/e2e/support.ts`}>browser tests</a> fail if a page keeps anything on the
        device or asks another site, the probes’{' '}
        <a href={`${SOURCE}/main/apps/factory/src/senses/device.ts`}>device check</a> fails a change to the app that
        keeps anything but the preview cookie, or keeps that when nobody asked, and the{' '}
        <a href={`${SOURCE}/main/docs/COMPONENTS/TELEMETRY.md#what-is-kept-of-a-visitor`}>telemetry</a> drops addresses
        before anything is stored.
      </p>
    </div>
  );
}
