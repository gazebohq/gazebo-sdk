# Changelog

## SDK 0.1.2 and CLI 0.1.2

- Add account-authorised service credential testing, complete-set replacement and deletion through the existing API.
- CLI accepts bounded private-file or piped JSON input; replacement and deletion require --yes.
- Distinguish failed verification from unsupported remote verification with nonzero CLI exits.
- Reject invalid/duplicate credential fields before HTTP and omit raw secret-bearing response details.
- CLI requires SDK ^0.1.2. Existing command and credential-retrieval contracts are unchanged.

Replacement is not a merge: omitted named keys are removed. Stored credential deletion does not revoke provider-side copies. There is no proxy capability in this release.
