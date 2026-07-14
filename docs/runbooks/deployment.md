# Deployment runbook: D1/R2-backed Careers MVP

## Authority, scope, and stop conditions

This runbook governs the Cloudflare Pages deployment that serves the Careers
MVP. D1 is the sole authority for public jobs: public listing, detail,
sitemap, and media routes read the active D1 revision and its immutable asset
bindings. The repository's JSON, generated HTML, Git history, and the legacy
site are not runtime fallbacks.

`wrangler.jsonc` binds `DB` and `JOB_MEDIA` to isolated production and preview
resources. **Do not deploy this configuration to staging or production** until
the exact host, Access, environment-variable, and secret gates below pass.

Every action marked **Manual/credentialed provider action** requires an
approved operator in the Cloudflare account. D1 binding IDs and R2 bucket names
are non-secret deployment configuration and belong in `wrangler.jsonc`. Do not
put account IDs, administrator identities, tokens, cookies, assertion headers,
or secret values in this repository, a terminal capture, or release evidence.

The following are absolute constraints:

- Use only exact approved HTTPS hosts and origins. Do not use a wildcard host,
  a Pages preview URL, an alternate domain, or a legacy host for admin access.
- Keep D1 and R2 private and server-bound. Do not enable a public R2 bucket,
  public R2 custom domain, or direct R2 fallback URL.
- R2 objects, asset rows, revisions, and D1 databases are retained. Detach,
  close, and rollback are state transitions; none authorizes physical deletion.
- Never restore the legacy browser PIN/PAT flow or any legacy/public-data
  fallback after cutover. See `security.md` for credential containment and
  rotation rules.
- Store no secret or personal data in source, `.dev.vars.example`, migration
  evidence, screenshots, logs, or command history.

## Required deployment inventory

Maintain this inventory in the approved private provider record. Values below
are labels: record each Pages project/environment, resource association,
operator, and redacted timestamp. Non-secret D1 binding IDs and R2 bucket names
also remain declared in `wrangler.jsonc` so future deployments cannot silently
replace the reviewed bindings.

| Environment | D1 binding                                       | R2 binding                                                    | Access and hostname inventory                                                                                                                        | Pass gate                                                                            |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Production  | `DB` -> one approved production-only D1 database | `JOB_MEDIA` -> one approved production-only private R2 bucket | Exact production canonical host and origin; production Access application issuer, production-only audience, and exact approved administrator address | No production resource ID, bucket, audience, or hostname is shared with staging.     |
| Staging     | `DB` -> one approved staging-only D1 database    | `JOB_MEDIA` -> one approved staging-only private R2 bucket    | Exact staging canonical host and origin; staging Access application issuer, staging-only audience, and exact approved administrator address          | No staging resource resolves to a production resource or production Access audience. |

**Manual/credentialed provider action:** create or identify the two D1
databases, the two R2 buckets, two Pages deployment environments, and separate
Access applications/audiences. Bind only `DB` and `JOB_MEDIA` to their matching
Pages environment. Confirm R2 public access is disabled and that no public
bucket domain or custom R2 domain is configured. Capture only opaque provider
resource identifiers in the private inventory.

**Fail:** the current local placeholder IDs are present in a remote binding;
any D1 database, R2 bucket, or Access audience is shared across environments;
a host policy includes `*`; R2 has a public route; or the exact administrator
address cannot be verified privately. Stop rather than substituting a preview
or legacy resource.

## Runtime configuration

Set the following values independently in each Pages environment. The
committed `.dev.vars.example` is intentionally inert and cannot be promoted to
a deployment configuration. The `PUBLIC` prefix is a code-level selector, not
provider-environment inheritance: `PUBLIC_CANONICAL_HOST` and
`PUBLIC_CANONICAL_ORIGIN` must be the exact host/origin of the Pages environment
where they are set.

| Name                       | Required value and use                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEPLOYMENT_ENVIRONMENT`   | Exactly `production` or `staging`. It selects the corresponding Access configuration for admin routes.                                                                                                                         |
| `PUBLIC_CANONICAL_HOST`    | Exact host only, without scheme, path, port, or wildcard. Public Functions use this value when constructing public origins. In each Pages environment it must be that environment's exact public host.                         |
| `PUBLIC_PAGES_HOST`        | Exact production `<project>.pages.dev` hostname. It may equal `PUBLIC_CANONICAL_HOST` while Pages is the canonical production surface; when distinct, safe public GET/HEAD requests on it receive a 308 to the canonical host. |
| `PUBLIC_CANONICAL_ORIGIN`  | `https://` plus the exact host in `PUBLIC_CANONICAL_HOST`, with no path, query, fragment, port, or trailing alternate host. It is the selected admin mutation origin when `DEPLOYMENT_ENVIRONMENT=production`.                 |
| `PUBLIC_ACCESS_ISSUER`     | Exact HTTPS origin for the production Access application, ending in `.cloudflareaccess.com` with no path.                                                                                                                      |
| `PUBLIC_ACCESS_AUDIENCE`   | Opaque production Access audience for that application only.                                                                                                                                                                   |
| `PUBLIC_ADMIN_EMAIL`       | Exact approved production administrator address, configured only in the provider secret/variable store.                                                                                                                        |
| `STAGING_CANONICAL_HOST`   | Exact staging host only, without scheme, path, port, or wildcard.                                                                                                                                                              |
| `STAGING_PAGES_HOST`       | Exact stable staging Pages hostname. It must differ from production; it may equal `STAGING_CANONICAL_HOST` when that stable Pages alias is the staging canonical surface. Unlisted preview aliases are denied.                 |
| `STAGING_CANONICAL_ORIGIN` | `https://` plus the exact staging canonical host, with no path, query, fragment, port, or alternate host. It is the staging admin mutation origin.                                                                             |
| `STAGING_ACCESS_ISSUER`    | Exact HTTPS origin for the staging Access application, ending in `.cloudflareaccess.com` with no path.                                                                                                                         |
| `STAGING_ACCESS_AUDIENCE`  | Opaque staging Access audience, different from the production audience.                                                                                                                                                        |
| `STAGING_ADMIN_EMAIL`      | Exact approved staging administrator address, configured only in the provider secret/variable store.                                                                                                                           |
| `CSRF_SIGNING_SECRET`      | A newly generated, cryptographically random 32-byte base64url value (43 characters). It is a provider secret, not a plain Pages variable and not a value for source or shell arguments. Use a distinct value per environment.  |

The admin Functions reject invalid configuration and require the request URL,
`Host`, forwarded host, HTTPS scheme, Access JWT issuer, audience, expiry, and
exact administrator email to agree. Admin mutations additionally require the
exact configured origin, same-origin fetch metadata, and a subject-bound CSRF
token. Do not compensate for an `ADMIN_UNAVAILABLE`, `NON_CANONICAL_HOST`, or
Access failure by adding another hostname or a permissive Access policy.

**Manual/credentialed provider action:** set non-secret values in the matching
Pages environment and set `CSRF_SIGNING_SECRET` with the provider's encrypted
secret mechanism. Enter secret values only in a non-echoing provider flow; do
not place them in a command line, `.dev.vars`, shell history, or evidence.
Confirm the production deployment has `DEPLOYMENT_ENVIRONMENT=production` and
the staging deployment has `DEPLOYMENT_ENVIRONMENT=staging`.

**Pass gate:** a private configuration review maps every name above to its
correct environment and shows no wildcard, cross-environment audience, or
unapproved host. **Fail:** a required value is absent, malformed, copied from
the other environment, or exposed outside the provider secret store.

## Staging migration rehearsal

The schema file is `migrations/0001_careers_mvp.sql`. The following command is
a Wrangler D1 command available through the repository's `wrangler`
development dependency; run it only after the private inventory identifies the
approved staging database name.

```sh
npx wrangler d1 execute "$STAGING_D1_DATABASE_NAME" --remote --file=migrations/0001_careers_mvp.sql
```

**Manual/credentialed provider action:** run the command against the approved
staging database only, and retain a redacted result showing success, database
identity, migration filename, and time. Do not use a production name during a
rehearsal. The migration is create-only schema work; do not reset or delete a
D1 database to repeat it.

Before importing Ablearn evidence, run the existing read-only repository audit:

```sh
npm run audit:migration:ablearn
```

There is deliberately no supported CLI that directly runs
`migrate-ablearn-to-d1.mjs` against a provider account. The actual import must
be performed by an approved, one-off, provider-bound runner that calls
`migrateAblearnToD1({ database, bucket, environment, actorSubject })` with the
staging `DB` and `JOB_MEDIA` bindings, `environment: "staging"`, and the
approved Access subject. It must not discover credentials, bindings, or a
deployment by itself.

The rehearsal pass evidence must show, without source bytes or personal data:

1. the audit passed before import;
2. the runner used the staging bindings and environment;
3. source/D1 snapshot hash, asset manifest hash, MIME, length, and R2 ETag
   checks passed before the active pointer changed;
4. the importer returned its stored terminal result on a same-environment,
   same-actor replay; and
5. public listing, detail, sitemap, and referenced media read from the staged
   D1 active revision rather than from repository data.

**Fail:** any audit mismatch, unbound runner, unexpected existing asset,
missing source object, hash/metadata mismatch, or nonterminal import result.
Keep the failed staging data for investigation; do not delete it or route
traffic to a legacy source.

### Conditional R2 conflict proof

Perform this proof in staging before production seed. It proves the runtime
uses create-only R2 writes, not merely that a normal upload succeeds.

**Manual/credentialed provider action:** use the approved staging-only runner
and a non-referenced, retained test object. First call the same
`putImmutableMedia` runtime helper with a verified supported fixture and its
operation-derived key (`uploads/<operation UUID>/<sha256>.<extension>`). Record
only the key, SHA-256, MIME, byte length, and ETag in the private evidence.
Then call the helper again with that exact key but different verified media
metadata. It must return `R2_KEY_INTEGRITY_CONFLICT` with HTTP 409.

**Pass gate:** a HEAD before and after the conflict has the same ETag, MIME,
length, and SHA-256 metadata, so the first object remains untouched. Retain the
staging proof object; it is not an orphan cleanup candidate. **Fail:** the
second write succeeds, the first object's metadata or ETag changes, a direct
unconditional `put` was used, or the proof needs an R2 delete. Block
production and investigate the binding/implementation.

## Staging smoke and operational readiness

Use the exact staging origin from the private inventory, never a Pages preview
or a wildcard host. The public HTTP check below is a smoke probe, not a build,
lint, formatter, or test command.

```sh
curl --fail --silent --show-error --max-time 10 --output /dev/null "$STAGING_ORIGIN/"
curl --fail --silent --show-error --max-time 10 --output /dev/null "$STAGING_ORIGIN/sitemap.xml"
```

**Manual verification:**

1. In a signed-out browser, the public listing, one seeded public detail route,
   sitemap, and one referenced `/media/<asset-id>` route are available only on
   the exact staging host. The media URL must be served by the Function; a
   direct R2 URL must not be available.
2. A user outside the exact staging Access policy cannot obtain `/admin/` or
   `/api/admin/` content. The provider's Access challenge/denial or the
   Function's safe unauthorized response is acceptable; administrative data is
   not.
3. The approved staging identity can enter `/admin/`, read the session, create
   a harmless draft, preview it, publish it, and observe the expected immutable
   revision. Do not put the user's email, assertion, CSRF token, request body,
   or draft contents in evidence.
4. Confirm each admin mutation response has no CORS grant and is `no-store`;
   confirm a cross-origin or stale-CSRF mutation is rejected.

Before any production window, **Manual/credentialed provider action:** enable
and privately record alert routes for Pages/Function deployment failures and
5xx errors, Access policy/audience changes and denial anomalies, and D1/R2
binding or operation failures visible in the provider logs. Verify the alert
recipient/escalation record privately, not in Git. Test a harmless alert path
where the provider supports it; do not manufacture customer data or disable
security controls to do so.

Redact all evidence to status, timestamp, safe route, correlation ID, opaque
provider resource identifier, hash, MIME, length, and ETag only. Before sharing
repository evidence, run the existing secret scan:

```sh
npm run audit:secrets
```

Manually inspect its result as required by `security.md`; the scan does not
prove that values such as emails, cookies, request bodies, or Access assertions
were removed. **Fail:** an alert route is unowned, evidence contains a secret
or personal data, or a smoke check relies on a public R2 or legacy endpoint.

## Production seed and cutover

### Preconditions

All staging gates above must have private, redacted passing evidence. In
addition, the release owner must have:

- a reviewed production deployment binding plan that replaces the local-only
  placeholders with the approved production `DB` and `JOB_MEDIA` resources;
- a reviewed exact production host, Access issuer/audience, and administrator
  policy with no wildcard or staging values;
- a deployed, verified Pages release that is compatible with the production
  schema but has no production active pointer yet;
- a named rollback operator, retained source revision procedure, alert owner,
  and a private maintenance decision; and
- a current Ablearn audit result from `npm run audit:migration:ablearn`.

**Manual/credentialed provider action:** apply the schema to the approved
production D1 database with the same Wrangler command shape used for staging,
substituting only the private production database name:

```sh
npx wrangler d1 execute "$PRODUCTION_D1_DATABASE_NAME" --remote --file=migrations/0001_careers_mvp.sql
```

The release operator then runs the approved one-off bound importer once with
production `DB`, production `JOB_MEDIA`, `environment: "production"`, and the
approved production actor subject. This is the production seed and cutover:
the importer verifies source and immutable R2 evidence, creates the revision
and bindings, and atomically moves the D1 active pointer in its normal publish
batch. Do not hand-author seed rows, point `jobs.active_revision_id` with SQL,
or copy JSON/static files into the deployed site.

**Pass gate:** the importer has a succeeded terminal record; the active
revision and asset manifest match its verified evidence; and the exact
production host resolves to the new Pages deployment. Mark D1 as the only
public authority at this boundary. Do not add a redirect, read fallback, or
emergency writer to the legacy site after this point. Preserve prior sites and
records read-only rather than deleting them.

**Fail boundary:** if the importer or pointer batch fails, do not retry with a
new environment, actor, source data, or manual D1/R2 repair. Preserve the
durable terminal record and immutable objects, investigate in the private
incident process, and leave the old public deployment unchanged until an
approved recovery path exists.

### Warmed production visibility probe (10-second limit)

Immediately before the pointer-changing publish/import, request the exact
canonical public detail URL once to warm the normal route. After the successful
terminal response, repeatedly request that _same URL_, with no alternate host
or cache-busting query, and verify the expected new public content. Begin the
timer at the terminal response and stop at the first matching response; the
maximum allowed elapsed time is **10 seconds**.

```sh
curl --fail --silent --show-error --max-time 10 "$PRODUCTION_ORIGIN/$JOB_SLUG/"
```

Record only the elapsed time, HTTP status, canonical host, job slug when it is
already public, and safe revision/hash reference. Pass only when the warmed
canonical route shows the newly active immutable revision within 10 seconds.
Fail if it remains stale at 10 seconds, returns an error, resolves through a
legacy host, or requires a direct R2/JSON URL. Stop the cutover and use the
protected rollback flow below to create a new revision from the retained
pre-cutover source; do not bypass the cache contract with a new hostname.

Complete the same public and Access smoke checks used in staging, now on the
exact production origin. Confirm that an approved production admin publish can
be observed through D1-backed public listing/detail/sitemap/media routes, and
that a non-approved identity remains denied.

## Rollback boundaries and D1 pointer rollback

A release rollback is not a deletion and not a restoration of the legacy
credential flow.

- **Before the production pointer changes:** stop the release, retain D1/R2
  artifacts and evidence, and keep the previous verified public deployment.
  Do not reset D1 or remove R2 objects.
- **After the pointer changes but before smoke passes:** use the protected
  production `/admin/` workspace on the exact canonical host. Do not use raw
  D1 SQL, the legacy site, repository JSON, or an R2 URL.
- **After smoke passes:** a code/deployment rollback is allowed only to a
  previously verified Pages release with the same approved production bindings
  and security configuration. It must continue reading D1; it cannot fall back
  to legacy/static data.

For one job, the authorized operator performs the pointer rollback in
`/admin/`:

1. Record the current active generation and choose the retained source revision
   ID returned by an earlier publish, close, or rollback. Verify the source is
   for that job.
2. Enter that source revision ID in the workspace's rollback control and submit
   the normal rollback operation with the current expected generation. Reload
   state before retrying a conflict; use a new idempotency key only through the
   UI's normal operation flow.
3. Pass only on the terminal `ROLLED_BACK` result. The server creates a new
   immutable revision that is byte-for-byte equivalent to the retained source
   snapshot and asset manifest, then atomically advances the D1 active pointer.
4. Run the warmed 10-second canonical visibility probe and the relevant public
   smoke checks. Record the new revision ID and safe correlation ID privately.

A generation/source guard failure, missing retained revision, or failed
terminal result leaves the current pointer authoritative. Stop and investigate;
do not issue a direct `UPDATE`, mutate the retained source, overwrite an R2
object, delete an asset/revision, or switch visitors to the legacy site.
