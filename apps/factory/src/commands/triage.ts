/**
 * `factory triage`: the triage worker (`packages/triage`), wired to the gateway, the page reader and the store.
 *
 *     factory triage
 *
 * Takes signals from the inbox until it is stopped. Settings come from the environment: GATEWAY_URL (the model
 * gateway), JUDGEMENTS_TOKEN (the caller token the gateway takes judgements with: the same value the gateway is
 * given), PAGES_URL (the probes' page reader, for a report's screenshot and the page's text; without it a report is
 * judged with neither), ARTIFACTS_DIR (where screenshots are), and DATABASE_URL or the PG* variables for the store,
 * which it connects to as its own role (`factory_triage`).
 *
 * PROMETHEUS_URL, LOKI_URL and TEMPO_URL are what the senses read besides the app, which triage looks at before it
 * trusts a sense's new problem (`ENVIRONMENT` in policy/triage.ts); the disk is read through Prometheus. Triage looks
 * only at those it has an address for, and with none it looks at nothing and holds nothing for the environment.
 *
 * As it starts, and every `INBOX.pruneMinutes` after, it deletes the inbox's repeats older than
 * `INBOX.keepCountedDays` (`pruneInbox` in packages/store), and forgets the visitors' reports older than
 * `REPORT_TEXT.keepDays` (`forgetReports`).
 */
import type { Counter } from '@opentelemetry/api';
import { type Screenshot, SIGNAL_SOURCES } from '@software-factory/events';
import { type Judge, type Outcome, type PageReader, Triage } from '@software-factory/triage';
import { INBOX, REPORT_TEXT } from '../../../../policy/triage.ts';
import { judgementsToken } from '../gateway/config.ts';

export const USAGE = '  factory triage';

/** Every way triage takes a signal: a record, so an outcome added to `Outcome` and left out here fails to type-check. */
const OUTCOMES: Record<Outcome, true> = {
  opened: true,
  evidence: true,
  counted: true,
  report: true,
  finding: true,
  reopened: true,
  held: true,
};

/**
 * Starts the count of signals triaged at 0 for each source and outcome, so the first of each after a restart is
 * counted: Prometheus's `increase` reads nothing into a series' first sample.
 */
export function zeroTriaged(triaged: Pick<Counter, 'add'>): void {
  for (const sense of SIGNAL_SOURCES) for (const outcome of Object.keys(OUTCOMES)) triaged.add(0, { sense, outcome });
}

export async function run(args: string[]): Promise<number> {
  const { GATEWAY_URL, JUDGEMENTS_TOKEN, PAGES_URL, ARTIFACTS_DIR, DATABASE_URL, PROMETHEUS_URL, LOKI_URL, TEMPO_URL } =
    process.env;
  let token: string | undefined;
  try {
    token = judgementsToken(JUDGEMENTS_TOKEN);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  if (args.length || !GATEWAY_URL || !token || !ARTIFACTS_DIR) {
    console.log(
      `Usage:\n${USAGE}\n\nSet GATEWAY_URL, JUDGEMENTS_TOKEN (the gateway's) and ARTIFACTS_DIR, and PAGES_URL to read the pages reports name.`,
    );
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { metrics } = await import('@opentelemetry/api');
  const { connect, DiskArtifacts, EventWriter, forgetReports, pruneInbox } = await import('@software-factory/store');
  const { GatewayClient } = await import('../gateway/client.ts');
  const { GatewayUnavailable } = await import('../gateway/errors.ts');
  const { waitingFor } = await import('../gateway/waiting.ts');
  const { sendCounts } = await import('../counts.ts');
  const { environmentLook } = await import('../environment.ts');
  const { Prometheus } = await import('../clients/prometheus.ts');
  const { Loki } = await import('../clients/loki.ts');
  const { Tempo } = await import('../clients/tempo.ts');

  const sql = connect(DATABASE_URL);
  const gateway = new GatewayClient({ url: GATEWAY_URL, token });

  const judge: Judge = async (request) => {
    try {
      return await gateway.judge(request);
    } catch (error) {
      // Waited out, as an outage is, so no report spends its attempts on it; but it is no outage, and only Martin can
      // end it, so it is an error in the log, and the gateway pages him (`JudgementsUnauthorized`).
      if (error instanceof GatewayUnavailable && error.status === 401) {
        log.error(
          'the gateway refused triage’s token: JUDGEMENTS_TOKEN is not the gateway’s; run make judgements-token',
        );
      }
      throw waitingFor(error, new Date()) ?? error;
    }
  };

  const read: PageReader = async (path) => {
    if (!PAGES_URL) return null;
    try {
      const response = await fetch(`${PAGES_URL.replace(/\/$/, '')}/v1/pages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`the page reader answered ${response.status}`);
      return (await response.json()) as { screenshot: Screenshot; passages: string[] };
    } catch (error) {
      // A report is still judged without its page: it just has no screenshot, and no passage to point to.
      log.warn({ path, err: error }, 'could not read the page');
      return null;
    }
  };

  const meter = metrics.getMeter('factory-triage');
  const triaged = meter.createCounter('factory.triage.signals', {
    description: 'Signals triaged, by sense and outcome (opened, evidence, counted, report, finding, reopened, held)',
  });
  zeroTriaged(triaged);
  const toTicket = meter.createHistogram('factory.triage.signal_to_ticket', {
    description: 'From a sense seeing something to its ticket opening',
    unit: 's',
  });
  meter
    .createObservableGauge('factory.inbox.waiting', { description: 'Signals in the inbox waiting for triage' })
    .addCallback(async (gauge) => {
      const [row] = await sql<{ waiting: number; failed: number }[]>`
        select count(*) filter (where attempts < ${INBOX.attempts})::int as waiting,
               count(*) filter (where attempts >= ${INBOX.attempts})::int as failed
        from inbox where triaged_at is null`.catch(() => []);
      if (row) {
        gauge.observe(row.waiting, { state: 'waiting' });
        gauge.observe(row.failed, { state: 'failed' });
      }
    });

  const look = environmentLook({
    prometheus: PROMETHEUS_URL ? new Prometheus(PROMETHEUS_URL) : undefined,
    loki: LOKI_URL ? new Loki(LOKI_URL) : undefined,
    tempo: TEMPO_URL ? new Tempo(TEMPO_URL) : undefined,
  });

  const triage = new Triage({
    sql,
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(ARTIFACTS_DIR) }),
    judge,
    read,
    look,
    log,
    onTriaged: (outcome, signal, _waited, ticketOpened) => {
      triaged.add(1, { sense: signal.sense, outcome });
      if (ticketOpened) {
        toTicket.record((Date.now() - Date.parse(signal.observedAt)) / 1000, { sense: signal.sense });
      }
    },
  });

  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'triage stopping');
      abort.abort();
    });
  }
  const looks = { prometheus: PROMETHEUS_URL ?? null, loki: LOKI_URL ?? null, tempo: TEMPO_URL ?? null };
  log.info({ gateway: GATEWAY_URL, pages: PAGES_URL ?? null, ...looks }, 'triage taking signals from the inbox');

  // The counts' zeros go before the first signal triage takes, which may be at once, from a backlog.
  await sendCounts();

  let pruning: Promise<void> | undefined;
  // One prune at a time: a tick that finds one still running leaves it be.
  const prune = () => {
    if (pruning) return;
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const before = daysAgo(INBOX.keepCountedDays);
    const repeats = pruneInbox(sql, before).then(
      (deleted) => {
        if (deleted) log.info({ deleted, before }, 'deleted the inbox’s old repeats');
      },
      // The next prune tries again; the inbox only grows meanwhile.
      (error) => log.warn({ err: error }, 'could not delete the inbox’s old repeats'),
    );
    // Only how many: never a report's words, its page or its work item.
    const kept = daysAgo(REPORT_TEXT.keepDays);
    const reports = forgetReports(sql, kept).then(
      ({ texts, reports }) => {
        if (texts || reports) log.info({ texts, reports, before: kept }, 'forgot the visitors’ old reports');
      },
      // The next prune tries again, an hour on: well within the day `keepDays` leaves before the promise.
      (error) => log.warn({ err: error }, 'could not forget the visitors’ old reports'),
    );
    pruning = Promise.all([repeats, reports])
      .then(() => undefined)
      .finally(() => {
        pruning = undefined;
      });
  };
  prune();
  const pruner = setInterval(prune, INBOX.pruneMinutes * 60 * 1000);
  try {
    await triage.run(abort.signal);
    return 0;
  } finally {
    clearInterval(pruner);
    await pruning;
    await Promise.all([sql.end(), shutdownTelemetry()]);
  }
}
