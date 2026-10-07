# The Antasphere chassis

The generic half of every Antasphere tool, as five packages published on npm under the
`@antasphere` scope and installed by every tool at one pinned version:

| Package                        | What it is                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@antasphere/chassis-db`       | The generic tables, the generated Better Auth schema, the migration runner                                 |
| `@antasphere/chassis-contract` | The generic zod schemas and route contracts, the hub wire copies                                           |
| `@antasphere/chassis-server`   | The generic server: identity, federation, middleware, routers, jobs, MCP kit; entry `createPlatform(tool)` |
| `@antasphere/chassis-sdk`      | The generic typed client (`ChassisClient`); a tool's client extends it                                     |
| `@antasphere/chassis-cli`      | The generic CLI: profiles, context, safe writes, generic commands; entry `defineCli(definition)`           |

The five move in lockstep: one version number, one tag, one release. A tool pins that number in
every package that depends on the chassis and checks it with `pnpm chassis:check`.

> **License.** The Antasphere chassis is [fair-code](https://faircode.io), distributed under the
> [Sustainable Use License](LICENSE): the source is open to read, and you may self-host what you
> build on it, modify it and use it for your own internal business or personal purposes, free of
> charge. You may not sell it or offer it to others as a paid or hosted service. It is
> source-available, not open source. Copyright (c) 2026 Antasphere.

Until 7 October 2026 these packages lived inside `antasphere/slideless` and were copied byte for byte
into every tool. This repository is that code, extracted with its history (its first commit is
Slideless's at `a869f78`), and `1.0.0` is exactly that chassis.

## Working here

```bash
pnpm install
pnpm turbo lint typecheck test build       # the gates
pnpm format:check
pnpm turbo test:integration                # the chassis-server suite on a real Postgres (testcontainers)
pnpm wire:check                            # the hub wire copies against the hub checkout beside this repository
```

A change here is one pull request on `main`, gated by CI (`checks`, `hub-wire`, `integration`).

## Releasing

```bash
pnpm release patch|minor|major [--title "…"] --push
```

On a clean `main`: bumps the root and the five packages together, commits
`chore(release): chassis X.Y.Z`, makes the annotated tag `vX.Y.Z` and pushes both. The tag runs
`release.yml`, which publishes the five packages to npm, public with provenance, by trusted publishing
(no token anywhere), skipping a version npm already has. The first publish of each name was manual; the trusted
publisher of each package names this repository and `release.yml`, so the file keeps its name.

## Consuming

The tool template (`antasphere/tool-template`) is the worked example: its `CLAUDE.md`, "The chassis
is a dependency", says how a tool installs, upgrades and contributes. In short:

- Every package that depends on the chassis declares the same exact version (`"1.2.0"`, never a range).
- Upgrading is `pnpm up -r "@antasphere/chassis-*@1.2.0"`, then the gates; a chassis bump that changes
  the auth schema is answered by regenerating the tool's snapshot and writing its migration.
- The packages are public: no registry token on a developer's machine, in CI or in a Docker build.
- Developing a chassis change against a tool: build the chassis, `pnpm link ../../chassis/packages/chassis-server`
  (and the siblings you touch) from the tool's root, work, then `git checkout package.json pnpm-lock.yaml
&& pnpm install` before committing. `pnpm chassis:check` refuses a `link:` left behind.
