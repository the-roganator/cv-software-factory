/**
 * `factory guardrails`: takes every proof a guardrail has outside an attack, and records each as `guardrail.proved`
 * (the catalogue, `policy/guardrails.ts`). `make guardrails` runs it from the Mac, as the proofs' store role through a
 * port-forward to Postgres, with Martin's `gh` and the local kubeconfig.
 *
 *     factory guardrails [--only <proof>]... [--no-record]
 *
 * It refuses to run unless the checkout's HEAD is `origin/main`'s head and its tree is clean, as `git status` shows it,
 * untracked files included and none hidden from it (skip-worktree, assume-unchanged), and records that commit with each proof: a loosened script in a branch or a worktree must
 * not record a proof as held. Before each append it checks the checkout is still that commit, clean, so a script that changed it stops the run.
 *
 * Each proof is taken in turn (`guardrails/proofs.ts`), what it runs shown as it goes, and recorded as soon as it is
 * taken: held or not, with its output verbatim (at most 4000 characters), the hash of the policies and Roles it was
 * taken against, and for one read from CI, its run. A proof that throws did not hold, and is recorded so, with why. A
 * proof that did not hold fails the command, which names it, and the line's count of security events pages Martin
 * (`guardrail-not-held`). Two are not recorded, and fail the command too: the stop-the-line drill, when Martin does not
 * say yes at its prompt; and a proof read from CI that finds no run to read.
 *
 * `--only` takes those proofs alone (repeat it for more). `--no-record` takes them and records nothing, so it runs from
 * any checkout: for trying a proof, never for its record.
 *
 * The store is the one `PGHOST` and the rest name, as the proofs' role (`factory_proofs`); `KUBE_CONTEXT` names the
 * cluster (`k3d-software-factory`). It runs the repository's scripts, so it runs from a checkout on the Mac alone, and
 * its code is loaded only when it runs: the factory's image holds none of it.
 */
export const USAGE = '  factory guardrails [--only <proof>]... [--no-record]';

export async function run(args: string[]): Promise<number> {
  const { run } = await import('../guardrails/command.ts');
  return run(args);
}
