# Gazebo CLI

**[Website](https://gazebohq.com) · [CLI guide](https://gazebohq.com/docs/cli)**

`@gazebohq/cli` is an ESM-only Node.js command-line client built on `@gazebohq/sdk`. Use maintained Node.js 22 or 24. Node.js 20 compatibility has been tested, but it is no longer a recommended deployment target. No separate HTTP implementation, saved login, or persistent configuration.

## Support and versioning

The first release is `0.1.0`. Before `1.0`, fixes use patch releases (for example, `0.1.1`); breaking changes use minor releases (for example, `0.2.0`) and are documented in release notes. SDK and CLI versions may advance independently, with GitHub release tags such as `sdk-v0.1.0` and `cli-v0.1.0`.

Report ordinary bugs through [GitHub Issues](https://github.com/gazebohq/gazebo-sdk/issues). Report vulnerabilities privately through [GitHub security reporting](https://github.com/gazebohq/gazebo-sdk/security/advisories/new), not public issues. There are no guaranteed response times or long-term support commitments.

Install with `npm install -g @gazebohq/cli`, or run `npx @gazebohq/cli --help`. Compiled JavaScript, MIT license, source, and self-contained build configuration are included.

## Run from source

```sh
pnpm --filter @gazebohq/cli run dev --help
pnpm --filter @gazebohq/cli run dev account get --json
```

Set tokens through your environment/secret manager, not command-line arguments or committed files:

- `GAZEBO_ACCOUNT_TOKEN` for account commands (`GAZEBO_API_TOKEN` is a compatibility fallback).
- `GAZEBO_AGENT_TOKEN` for scoped credential retrieval. It never falls back to an account token.
- Alternatively, use `--token-file PATH` pointing to a private file. File content is read once and trimmed; the CLI never writes or stores it.
- `GAZEBO_ENDPOINT` or `--endpoint URL` selects the deployment. Default: `https://app.gazebohq.com`.

Tokens must be supplied by the caller; the CLI does not open a login flow or create an account API token. Use HTTPS remotely. Local HTTP and endpoint path prefixes are supported.

## Commands

The following examples use the compiled binary in this checkout. Build the SDK before the CLI:

```sh
pnpm --filter @gazebohq/sdk build
pnpm --filter @gazebohq/cli build
node lib/gazebo-cli/dist/bin.js --help
node lib/gazebo-cli/dist/bin.js account get --json
node lib/gazebo-cli/dist/bin.js agents list
node lib/gazebo-cli/dist/bin.js services list
node lib/gazebo-cli/dist/bin.js access get AGENT_ID
node lib/gazebo-cli/dist/bin.js access set AGENT_ID stripe --enabled true --methods GET
node lib/gazebo-cli/dist/bin.js access set AGENT_ID stripe --enabled false --methods GET
node lib/gazebo-cli/dist/bin.js agents delete AGENT_ID --yes
```

Access updates replace a policy, so methods are always explicit. Supported methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`; lowercase CLI input is normalized. Method policies control credential release, not subsequent provider actions.

### Sensitive output

Agent creation returns its token only once. The CLI refuses to create unless you explicitly request that sensitive output:

```sh
node lib/gazebo-cli/dist/bin.js agents create --name "My agent" --reveal --json
```

Optional `--expires-at` takes a UTC ISO timestamp. Store the resulting token securely. Do not run this in a recorded terminal or capture stdout in public CI logs. If you redirect to a file, create it with private permissions first.

Credential retrieval similarly requires explicit output permission:

```sh
node lib/gazebo-cli/dist/bin.js credentials get stripe --reveal --method GET --key-name api_key --json
```

This uses the **agent** token and prints one sensitive credential. `--key-name` is optional; omission uses server primary-key selection. `--method` is optional and defaults to the server's `GET` behavior.

`--reveal` is required in scripts too. Without it, neither command sends an HTTP request. There is no implicit redacted retrieval that still releases a credential.

### Audit pagination

```sh
node lib/gazebo-cli/dist/bin.js audit list --limit 50 --service stripe --outcome success --json
node lib/gazebo-cli/dist/bin.js audit list --limit 50 --service stripe --outcome success --cursor CURSOR --json
```

Filters: `--limit` (integer 1–200), `--cursor`, `--agent-id`, `--service`, `--outcome` (`success`, `denied`, `not_found`), `--from`, `--to`.

One invocation returns one page with `events`, `nextCursor`, and `hasMore`. Preserve filters while advancing the opaque cursor. No automatic pagination or retries.

### Local compatibility

```sh
node lib/gazebo-cli/dist/bin.js --endpoint http://localhost:8787 credentials get stripe --reveal
```

This demonstrates endpoint configurability only; the local broker is not implemented.

## Output, errors, and cancellation

- Default output: readable, indented JSON.
- `--json`: compact JSON suitable for scripts.
- Results go only to stdout. Errors go only to stderr.
- JSON errors have `{ error: { code, message, status?, retryAfter? } }`.
- Error output excludes raw server payloads, stack traces, and transport error details.
- Account identity may contain email; treat normal output appropriately too.
- `--timeout-ms` overrides the SDK's 10-second timeout, including body reads.
- Ctrl+C/SIGTERM abort in-flight SDK requests.
- Exit codes: `0` success/help, `1` request/configuration failure, `2` usage/missing token, `130` request cancellation.
- `--yes` explicitly confirms agent deletion; no interactive prompt is needed in CI.

No `--token` option: command-line arguments can appear in shell history or process listings. The CLI does not save tokens or print them in diagnostics.

## Security boundary

`credentials get --reveal` prints the actual stored provider credential. The calling runtime or its host receives that key; use trusted environments and narrowly scoped provider credentials. Declared-method policies govern credential release, not later provider calls.

Agent deletion blocks future retrieval, not use of keys already retrieved. A leaked provider key may need provider-side revocation or rotation. Audit output describes credential access, not all downstream actions.

Securely supply the appropriate token. Services can be connected in the dashboard
or through the service credential commands described below (0.1.2 or newer).
Keep users' agent tokens separate; do not use an account administration
token as their runtime credential. The CLI has no automatic browser consent flow
or provider request proxy.


## Service credential management (0.1.2)

These commands require CLI 0.1.2 or newer. After building the workspace SDK and CLI:

```sh
node lib/gazebo-cli/dist/bin.js services credentials test stripe --input-file /private/credentials.json --json
node lib/gazebo-cli/dist/bin.js services credentials replace stripe --input-file /private/credentials.json --yes --json
node lib/gazebo-cli/dist/bin.js services credentials delete stripe --yes --json
```

The input file contains a nonempty JSON array, for example
`[{"keyName":"api_key","value":"FICTIONAL_EXAMPLE_ONLY"}]`.
Read real values from a trusted secret store; do not paste them into a model
conversation or put them in shell arguments. `--input-file -` accepts piped stdin.
Input is bounded to 64 KiB; malformed JSON, duplicate/empty names, empty values
and unexpected fields fail locally. Authentication still uses an account-token
environment variable or a separate token file, never a scoped agent token.

**`replace` replaces ALL keys for the service, not a merge.** Omitted keys are
removed; existing agents may depend on them. Both replacement and deletion
require `--yes`. Neither invalidates previously retrieved provider keys.
Do not use generic replacement as a provider OAuth connect/refresh mechanism.
There is no atomic create-only operation or automatic rollback of a multi-step
setup; report completed stages and avoid deleting shared services on failure.

`test` checks supplied credentials without saving. Verified success exits 0;
unsupported remote verification exits 1 with `not_verified`; an HTTP-200 failed
test exits 1 with `verification_failed`; HTTP/transport failures retain their
normal structured error codes. Failed/skipped tests write to stderr, not stdout.
An unsupported remote test is not proof a key is valid. Testing and replacement
are independent requests. Supplied credentials and raw server errors are not
echoed by these commands.

File/stdin input avoids putting secrets in process arguments, but the CLI process,
its host and any agent with access to the input can still read them. No secure
secret handoff or model isolation is implied.

## Development

After local archive installation, the same commands are available as `gazebo account get --json`, `gazebo services list`, and so on. The installed binary is verified separately from direct `node` invocation.

```sh
pnpm --filter @gazebohq/cli run typecheck
pnpm --filter @gazebohq/cli test
pnpm --filter @gazebohq/cli build
```

For a standalone source checkout, install its development dependencies and the matching SDK, then run `pnpm run build`. The CLI build itself does not invoke monorepo commands or use an external tsconfig. Tests require both packages to have been built first.

Tests exercise the CLI through the real SDK against a local HTTP fixture and through child processes, using synthetic tokens only. They do not authenticate against Gazebo Cloud.

The packed CLI depends on the public SDK name with a normal semver range. The checkout uses a workspace link that packing rewrites automatically; archives contain no workspace dependency protocol.

License: MIT. Copyright notice: Gazebo contributors.

