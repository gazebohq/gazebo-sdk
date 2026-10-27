# Gazebo SDK and CLI

TypeScript SDK and command-line tools for Gazebo.

| Package | Purpose |
| --- | --- |
| `@gazebohq/sdk` | Account management, scoped credential retrieval, and server-side consent helpers |
| `@gazebohq/cli` | Terminal and scripting interface built on the SDK |

## Documentation

- [SDK guide](https://gazebohq.com/docs/sdk)
- [CLI guide](https://gazebohq.com/docs/cli)
- [SDK source and reference](lib/gazebo-sdk/README.md)
- [CLI source and command reference](lib/gazebo-cli/README.md)

## Build and test from source

Use a maintained Node.js release (Node 22 or 24 recommended) and pnpm 10.34.2.
The packages declare Node 20+ compatibility; Node 20 is end-of-life.

```sh
pnpm install --frozen-lockfile
pnpm check
node lib/gazebo-cli/dist/bin.js --help
```

`pnpm check` typechecks, builds the SDK before the CLI, and runs the SDK,
consent, CLI and quickstart tests. Tests use synthetic credentials and local
HTTP fixtures, not a Gazebo account. No real credentials are required.

The repository contains both packages under `lib/`. The CLI uses a workspace
dependency on the SDK; pnpm converts this to ordinary semver when packing.

## Security boundary

Gazebo releases approved provider credentials to the requesting runtime. The
runtime host can access those keys. Revoking access stops future retrieval; it
does not invalidate keys already retrieved.

Declared HTTP methods control credential release, not subsequent provider
requests. Audit events record retrieval activity, not all actions performed
later with a released key. This is not a provider request proxy.

Account tokens are for trusted administration; agent tokens are for scoped
runtime access. Keep all tokens and provider keys out of browser code, model
prompts, logs and source control.

Consent helpers do not provide application sign-in or a ready-made UI.
Applications must implement authenticated callbacks, encrypted per-user
storage and shared locking as described in the consent guide.

Local endpoint configuration does not imply that a local broker exists.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT. Copyright Gazebo contributors.
