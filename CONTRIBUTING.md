# Contributing

Thanks for taking the time to help. Bug reports and feature ideas go in
GitHub issues; pull requests are welcome too. For anything larger than a
small fix, open an issue first so we can agree on the approach.

This is the author's own tooling, published in case it is useful, so
changes that only make sense for a very different setup may be declined.

## Running from source

`docker-compose.dev.yml` builds both images from source. With a foreman
checkout next to this one (`../foreman`):

```bash
cp .env.example .env    # set POSTGRES_PASSWORD, and ANTHROPIC_API_KEY for the runner
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

## Running the checks

```bash
cd app && npm ci && npm run typecheck && npm test         # API
cd app/pwa && npm ci && npm run typecheck && npm test     # PWA
./scripts/smoke-public-stack.sh --build                  # whole stack, then torn down
```

CI (`.github/workflows/security-check.yml`) runs the same tests plus
shellcheck, yamllint, a JSON syntax check, hadolint, a gitleaks secret scan
and a compose smoke test on every push and pull request.

Schema changes go through Drizzle migrations (`app/drizzle/`); see
`AGENTS.md` for the conventions agents (and people) follow in this repo.

## Commits

Keep commits focused, and start the subject with one of these prefixes:

| Prefix | Use for |
| --- | --- |
| `Add:` | new functionality or resource |
| `Edit:` | changes to existing functionality |
| `Fix:` | bug fixes |
| `Update:` | dependency, version, configuration or data updates |
| `Remove:` | removing functionality or a resource |
| `Docs:` | documentation-only changes |
| `DevOps:` | CI, packaging and other operational changes |

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
