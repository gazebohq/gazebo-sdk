# Contributing

Use a maintained Node.js release and pnpm 10.34.2.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Keep SDK and CLI changes aligned. The CLI uses the SDK for HTTP access rather
than maintaining a second transport.

Tests must use synthetic credentials and injected transports or local HTTP
fixtures. Do not add real account tokens, provider keys, production callbacks,
or cloud requests to the test suite.

For bugs, include Node/pnpm versions, a minimal reproduction and redacted
errors. Never attach credential values or authorization headers.

Submit changes through a pull request. Publishing packages, changing runtime
dependencies, or changing the supported API surface requires maintainer review.
