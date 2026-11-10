// The command line of `try` (bin/try): the logic is try.ts, the cluster try-ops.ts.
import { main } from './try.ts';
import { ops } from './try-ops.ts';

process.exitCode = await main(process.argv.slice(2), ops);
