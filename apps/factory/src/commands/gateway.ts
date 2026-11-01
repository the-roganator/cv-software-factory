/**
 * `factory gateway`: the model gateway (spec section 7.1), the only way from the factory to a model.
 *
 *     factory gateway
 *
 * Serves `POST /v1/judgements` (to triage, with JUDGEMENTS_TOKEN), `POST /v1/messages` (to runners, with a job token),
 * `GET /v1/spend` and `GET /health` on PORT (default 8080), and runs until it is stopped. Settings come from the
 * environment (see `gateway/config.ts`), and DATABASE_URL or the PG* variables for the store, which it connects to as
 * its own role (`factory_gateway`).
 */
import { configFromEnv } from '../gateway/config.ts';

export const USAGE = '  factory gateway';

export async function run(args: string[]): Promise<number> {
  if (args.length) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  let config: ReturnType<typeof configFromEnv>;
  try {
    config = configFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { startGateway } = await import('../gateway/service.ts');
  const { log } = await import('../log.ts');
  const { stop } = await startGateway(config);

  // Kubernetes sends SIGTERM before it stops the pod: finish the requests in flight, then flush telemetry.
  return new Promise<number>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'gateway stopping');
        void Promise.all([stop(), shutdownTelemetry()]).then(
          () => resolve(0),
          () => resolve(1),
        );
      });
    }
  });
}
