# Gazebo SDK and CLI

TypeScript SDK and command-line tools for Gazebo.

- **SDK:** `@gazebohq/sdk` — integrate scoped credential retrieval and supported account operations into applications and agents.
- **CLI:** `@gazebohq/cli` — use Gazebo from the terminal and scripts.

## Documentation

- [SDK guide](https://gazebohq.com/docs/sdk)
- [CLI guide](https://gazebohq.com/docs/cli)
- [Agent Consent Flow](https://gazebohq.com/docs/consent)

## Security boundary

Gazebo releases approved provider credentials to the requesting runtime. The runtime host can access those credentials. Revoking access stops future retrieval; it does not invalidate provider keys already retrieved.
