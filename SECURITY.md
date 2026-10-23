# Security

Do not report vulnerabilities with credentials or exploit details in a public
issue.

Use this repository's GitHub **Security → Report a vulnerability** option when
available. If private reporting is unavailable, contact Gazebo through the
support channel listed on [gazebohq.com](https://gazebohq.com) and request a
private reporting route before sharing details.

Do not send live credentials. Include a minimal synthetic reproduction,
affected package/version and impact.

These clients retrieve actual provider credentials. Runtime hosts can access
them, and revoking Gazebo access does not invalidate already-retrieved keys.
Use trusted runtimes and narrowly scoped provider credentials.
