# Contributing

Thank you for looking. This repository is unusual: most of its work is meant to be done by the factory itself. Agents write the code, deterministic gates decide what ships, and I (Martin Rogan) own the rules and review what matters. It is also my portfolio, so I keep its scope deliberately narrow.

## Issues

Bug reports, questions and ideas are welcome. Use the issue templates.

The factory acts only on issues it opened itself or that I have labelled for it, so opening an issue never sets an agent to work on its own. Until the factory is running, I read and triage every issue myself.

## Pull requests

Small fixes (typos, broken links, clearer docs) are welcome as pull requests. For anything larger, please open an issue first, because I may decline a good change that doesn't fit the project.

Because the repository is public, outside pull requests are treated as untrusted:

- Workflows from a first-time contributor wait for my approval before they run.
- Pull requests run with read-only permissions and no secrets (`pull_request`, never `pull_request_target`).
- Nothing from outside is merged automatically.

## Working on it

The toolchain is in `mise.toml`, each tool with the releases it may move within, and `mise.lock` holds the exact version of each, with its checksum for a Mac, CI's runners and the dev container, so one command installs the same toolchain everywhere:

```sh
mise install
pnpm install
make check    # lint, type-check, tests, design tokens, manifests
pnpm dev      # the console on http://localhost:5173, with the samples
make e2e      # every browser test CI runs: the console's (live ones against a throwaway Postgres), and the probes'
```

The toolchain moves only when someone upgrades it. `mise upgrade` takes the newest release in each tool's range that is at least three days old (`--bump` goes past the range, and rewrites it), and writes `mise.lock`; both files go in a `chore(toolchain)` pull request, through the same checks as any other change. Dependabot does not read mise, so nothing proposes it. A tool held to a server's version (`kubectl`, `argocd`, `argo-rollouts`, `promtool`) moves past its minor release only with that server, Node only with the images (`scripts/image-pins.test.ts`), and pnpm with `packageManager` in `package.json` (`scripts/toolchain.test.ts` holds them together). That pnpm is the runners' too: the runner image installs the release `mise.lock` holds, checked against its checksum there, so each upgrade reaches the runners with the next image. The app pins its own pnpm and moves it on its own, within the same major; the runners install the app's dependencies with this repository's, and a new major is a deliberate `--bump` in both repositories. Without the lock, every install would take that day's release in each range, and CI would undo Dependabot's cooldown and pnpm's one-day minimum release age; with it, CI installs with `--locked`, and fails on a request the lock does not hold.

A snapshot that fails only on CI usually comes down to timing, and CI's runner is slower than a laptop. It often reproduces in the pinned image given less CPU: `make e2e CPUS=1.5 ARGS='-g "<test name>" --repeat-each=15'`, which runs only the console's tests, not the live ones, the speed test or the probes.

Or open the repository in its dev container.

- Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org): `fix(console): …`, `docs: …`. A commit hook checks them.
- Pull requests are squash-merged; `main` accepts nothing else.
- Keep the docs current in the same pull request as the change. Start with [`AGENTS.md`](AGENTS.md): it applies to people as well as agents.

## Tests

Every change that adds or changes behaviour comes with tests that prove it, in the same pull request:

- **New functionality** is tested where it is used: at its public interface, never its internals ([`docs/REVIEWERS.md`](docs/REVIEWERS.md), rule 5).
- **A bug fix** comes with a test that fails without the fix.
- **A test is not weakened to make a change pass.** One that no longer holds is changed or removed on purpose, and the pull request says why.

Unit and database tests are Vitest's (`*.test.ts`, mostly in each package's `test/` folder); browser tests are Playwright's, in `apps/console/e2e`. `make check` and `make e2e` run them, and CI runs them on every pull request and again in the merge queue. The pull request template asks which tests prove the change.

By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE).
