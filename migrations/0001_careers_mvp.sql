PRAGMA foreign_keys = ON;

CREATE TABLE reserved_slugs (
  slug TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL CHECK(created_at > 0)
);

INSERT INTO reserved_slugs (slug, reason, created_at) VALUES
  ('admin', 'protected administrator routes', 1),
  ('author', 'retired author route', 1),
  ('api', 'function API routes', 1),
  ('media', 'private media route', 1),
  ('assets', 'static asset route', 1),
  ('sitemap.xml', 'sitemap route', 1),
  ('robots.txt', 'static robots route', 1),
  ('manifest.webmanifest', 'static manifest route', 1),
  ('favicon.ico', 'static favicon route', 1),
  ('404.html', 'static not-found document', 1);

CREATE TABLE companies (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  normalized_name TEXT NOT NULL UNIQUE COLLATE NOCASE
    CHECK(normalized_name = lower(trim(normalized_name))),
  company_json TEXT NOT NULL CHECK(json_valid(company_json) AND json_type(company_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(
    length(slug) BETWEEN 1 AND 80
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND substr(slug, 1, 1) <> '-'
    AND substr(slug, -1, 1) <> '-'
    AND slug NOT LIKE '%--%'
  ),
  active_revision_id TEXT REFERENCES job_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK(active_generation >= 0),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK((active_revision_id IS NULL AND active_generation = 0) OR active_revision_id IS NOT NULL)
);

CREATE TABLE job_drafts (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  company_id TEXT REFERENCES companies(id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  draft_json TEXT NOT NULL CHECK(json_valid(draft_json) AND json_type(draft_json) = 'object'),
  company_snapshot_json TEXT NOT NULL CHECK(
    json_valid(company_snapshot_json) AND json_type(company_snapshot_json) = 'object'
  ),
  application_json TEXT NOT NULL CHECK(
    json_valid(application_json) AND json_type(application_json) = 'object'
  ),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);

CREATE TABLE mutation_operations (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND id = lower(id)),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('company', 'job')),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK(operation IN (
    'create_company', 'update_company', 'create_job', 'update_draft',
    'upload_asset', 'detach_asset', 'publish', 'close', 'rollback'
  )),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) = 36 AND idempotency_key = lower(idempotency_key)),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  frozen_input TEXT NOT NULL CHECK(json_valid(frozen_input) AND json_type(frozen_input) = 'object'),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 320),
  environment TEXT NOT NULL CHECK(length(environment) BETWEEN 1 AND 80),
  retry_of TEXT REFERENCES mutation_operations(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'succeeded', 'failed')),
  lease_token TEXT NOT NULL CHECK(length(lease_token) BETWEEN 1 AND 128),
  lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at > 0),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count >= 1),
  terminal_http_status INTEGER CHECK(terminal_http_status BETWEEN 100 AND 599),
  terminal_code TEXT CHECK(terminal_code IS NULL OR length(terminal_code) BETWEEN 1 AND 80),
  terminal_body TEXT CHECK(terminal_body IS NULL OR json_valid(terminal_body)),
  terminal_correlation_id TEXT CHECK(
    terminal_correlation_id IS NULL OR length(terminal_correlation_id) BETWEEN 1 AND 128
  ),
  result_revision_id TEXT,
  result_asset_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  terminal_at INTEGER,
  UNIQUE(scope_type, scope_id, idempotency_key),
  CHECK(
    (state = 'pending'
      AND terminal_http_status IS NULL
      AND terminal_code IS NULL
      AND terminal_body IS NULL
      AND terminal_correlation_id IS NULL
      AND terminal_at IS NULL)
    OR
    (state IN ('succeeded', 'failed')
      AND terminal_http_status IS NOT NULL
      AND terminal_code IS NOT NULL
      AND terminal_body IS NOT NULL
      AND terminal_correlation_id IS NOT NULL
      AND terminal_at IS NOT NULL)
  )
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  r2_key TEXT NOT NULL UNIQUE CHECK(length(r2_key) BETWEEN 1 AND 1024),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 20971520),
  detected_mime TEXT NOT NULL CHECK(detected_mime IN (
    'image/png', 'image/jpeg', 'image/webp', 'application/pdf'
  )),
  verification_state TEXT NOT NULL DEFAULT 'verified' CHECK(verification_state = 'verified'),
  verified_at INTEGER NOT NULL CHECK(verified_at > 0),
  etag TEXT NOT NULL CHECK(length(etag) BETWEEN 1 AND 256),
  created_by_operation_id TEXT REFERENCES mutation_operations(id),
  created_at INTEGER NOT NULL CHECK(created_at > 0)
);

CREATE TABLE draft_asset_refs (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK(
    length(role) BETWEEN 1 AND 64
    AND role NOT GLOB '*[^a-z0-9-]*'
    AND substr(role, 1, 1) NOT IN ('-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9')
  ),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
  attached_at INTEGER NOT NULL CHECK(attached_at > 0),
  detached_at INTEGER CHECK(detached_at IS NULL OR detached_at >= attached_at),
  PRIMARY KEY(job_id, asset_id, role),
  UNIQUE(job_id, role, ordinal)
);

CREATE TABLE job_revisions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  base_generation INTEGER NOT NULL CHECK(base_generation >= 0),
  status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
  asset_manifest_json TEXT NOT NULL CHECK(
    json_valid(asset_manifest_json) AND json_type(asset_manifest_json) = 'array'
  ),
  parent_revision_id TEXT REFERENCES job_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  rollback_source_revision_id TEXT REFERENCES job_revisions(id) DEFERRABLE INITIALLY DEFERRED,
  created_by_operation_id TEXT NOT NULL UNIQUE REFERENCES mutation_operations(id),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  UNIQUE(job_id, revision_number)
);

CREATE TABLE revision_assets (
  revision_id TEXT NOT NULL REFERENCES job_revisions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK(
    length(role) BETWEEN 1 AND 64
    AND role NOT GLOB '*[^a-z0-9-]*'
    AND substr(role, 1, 1) NOT IN ('-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9')
  ),
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0),
  PRIMARY KEY(revision_id, asset_id, role),
  UNIQUE(revision_id, role, ordinal)
);

CREATE TABLE operation_lease_guards (
  operation_id TEXT PRIMARY KEY REFERENCES mutation_operations(id),
  expected_state TEXT NOT NULL CHECK(expected_state = 'pending'),
  expected_lease_token TEXT NOT NULL CHECK(length(expected_lease_token) BETWEEN 1 AND 128),
  expected_lease_expires_at INTEGER NOT NULL CHECK(expected_lease_expires_at > 0),
  created_at INTEGER NOT NULL CHECK(created_at > 0)
);

CREATE TABLE operation_asset_guards (
  operation_id TEXT NOT NULL REFERENCES mutation_operations(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  role TEXT NOT NULL CHECK(length(role) BETWEEN 1 AND 64),
  expected_sha256 TEXT NOT NULL CHECK(
    length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  expected_mime TEXT NOT NULL CHECK(expected_mime IN (
    'image/png', 'image/jpeg', 'image/webp', 'application/pdf'
  )),
  expected_byte_length INTEGER NOT NULL CHECK(expected_byte_length > 0 AND expected_byte_length <= 20971520),
  require_active_draft_ref INTEGER NOT NULL CHECK(require_active_draft_ref IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at > 0),
  PRIMARY KEY(operation_id, asset_id, role)
);

CREATE TABLE operation_attempts (
  id INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES mutation_operations(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number >= 1),
  lease_token TEXT NOT NULL CHECK(length(lease_token) BETWEEN 1 AND 128),
  started_at INTEGER NOT NULL CHECK(started_at > 0),
  finished_at INTEGER CHECK(finished_at IS NULL OR finished_at >= started_at),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('claimed', 'succeeded', 'failed', 'replayed', 'in_progress')),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),
  correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 128),
  UNIQUE(operation_id, attempt_number)
);

CREATE INDEX jobs_active_revision_idx ON jobs(active_revision_id);
CREATE INDEX job_revisions_job_created_idx ON job_revisions(job_id, revision_number DESC);
CREATE INDEX revision_assets_asset_idx ON revision_assets(asset_id);
CREATE INDEX draft_asset_refs_active_idx ON draft_asset_refs(job_id, detached_at, role, ordinal);
CREATE INDEX mutation_operations_lookup_idx ON mutation_operations(scope_type, scope_id, idempotency_key);
CREATE INDEX mutation_operations_retry_idx ON mutation_operations(retry_of);
CREATE INDEX operation_attempts_operation_idx ON operation_attempts(operation_id, attempt_number DESC);

CREATE TRIGGER reserved_slugs_no_update
BEFORE UPDATE ON reserved_slugs
BEGIN
  SELECT RAISE(ABORT, 'RESERVED_SLUGS_IMMUTABLE');
END;

CREATE TRIGGER reserved_slugs_no_delete
BEFORE DELETE ON reserved_slugs
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER jobs_reserved_slug_insert
BEFORE INSERT ON jobs
WHEN EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN
  SELECT RAISE(ABORT, 'RESERVED_SLUG');
END;

CREATE TRIGGER jobs_reserved_slug_update
BEFORE UPDATE OF slug ON jobs
WHEN EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug)
BEGIN
  SELECT RAISE(ABORT, 'RESERVED_SLUG');
END;

CREATE TRIGGER jobs_identity_immutable
BEFORE UPDATE OF id, slug ON jobs
WHEN NEW.id <> OLD.id OR NEW.slug <> OLD.slug
BEGIN
  SELECT RAISE(ABORT, 'JOB_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER jobs_active_pointer_guard
BEFORE UPDATE OF active_revision_id, active_generation ON jobs
WHEN NEW.active_revision_id IS NOT OLD.active_revision_id
  OR NEW.active_generation <> OLD.active_generation
BEGIN
  SELECT CASE
    WHEN NEW.active_revision_id IS NULL THEN RAISE(ABORT, 'ACTIVE_REVISION_REQUIRED')
    WHEN NEW.active_generation <> OLD.active_generation + 1 THEN RAISE(ABORT, 'ACTIVE_GENERATION_INVALID')
    WHEN NOT EXISTS (
      SELECT 1 FROM job_revisions
      WHERE id = NEW.active_revision_id
        AND job_id = NEW.id
        AND base_generation = OLD.active_generation
    ) THEN RAISE(ABORT, 'ACTIVE_REVISION_JOB_MISMATCH')
    WHEN (
      SELECT COUNT(*) FROM revision_assets WHERE revision_id = NEW.active_revision_id
    ) <> (
      SELECT COUNT(*) FROM json_each(
        (SELECT asset_manifest_json FROM job_revisions WHERE id = NEW.active_revision_id)
      )
    ) THEN RAISE(ABORT, 'ACTIVE_REVISION_ASSET_BINDING_MISMATCH')
    WHEN EXISTS (
      SELECT 1
      FROM json_each((SELECT asset_manifest_json FROM job_revisions WHERE id = NEW.active_revision_id)) AS manifest
      WHERE NOT EXISTS (
        SELECT 1 FROM revision_assets
        WHERE revision_id = NEW.active_revision_id
          AND asset_id = json_extract(manifest.value, '$.assetId')
          AND role = json_extract(manifest.value, '$.role')
          AND ordinal = json_extract(manifest.value, '$.ordinal')
      )
    ) THEN RAISE(ABORT, 'ACTIVE_REVISION_ASSET_BINDING_MISMATCH')
  END;
END;

CREATE TRIGGER companies_no_delete
BEFORE DELETE ON companies
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER jobs_no_delete
BEFORE DELETE ON jobs
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER job_drafts_version_guard
BEFORE UPDATE ON job_drafts
WHEN NEW.job_id <> OLD.job_id
  OR NEW.created_at <> OLD.created_at
  OR NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'DRAFT_VERSION_INVALID');
END;

CREATE TRIGGER job_drafts_no_delete
BEFORE DELETE ON job_drafts
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER assets_immutable
BEFORE UPDATE ON assets
BEGIN
  SELECT RAISE(ABORT, 'ASSET_IMMUTABLE');
END;

CREATE TRIGGER assets_no_delete
BEFORE DELETE ON assets
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER draft_asset_refs_detach_only
BEFORE UPDATE ON draft_asset_refs
WHEN NEW.job_id <> OLD.job_id
  OR NEW.asset_id <> OLD.asset_id
  OR NEW.role <> OLD.role
  OR NEW.ordinal <> OLD.ordinal
  OR NEW.attached_at <> OLD.attached_at
  OR OLD.detached_at IS NOT NULL
  OR NEW.detached_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'DRAFT_ASSET_REF_IMMUTABLE');
END;

CREATE TRIGGER draft_asset_refs_no_delete
BEFORE DELETE ON draft_asset_refs
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER job_revisions_insert_guard
BEFORE INSERT ON job_revisions
BEGIN
  SELECT CASE
    WHEN json_extract(NEW.snapshot_json, '$.status') <> NEW.status THEN RAISE(ABORT, 'SNAPSHOT_STATUS_MISMATCH')
    WHEN NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN operation_lease_guards AS lease_guard ON lease_guard.operation_id = operation.id
      WHERE operation.id = NEW.created_by_operation_id
        AND operation.scope_type = 'job'
        AND operation.scope_id = NEW.job_id
        AND operation.operation IN ('publish', 'close', 'rollback')
        AND operation.state = 'pending'
        AND operation.lease_token = lease_guard.expected_lease_token
        AND operation.lease_expires_at = lease_guard.expected_lease_expires_at
    ) THEN RAISE(ABORT, 'REVISION_OPERATION_GUARD_FAILED')
    WHEN NEW.revision_number <> COALESCE(
      (SELECT MAX(revision_number) + 1 FROM job_revisions WHERE job_id = NEW.job_id), 1
    ) THEN RAISE(ABORT, 'REVISION_NUMBER_INVALID')
  END;
END;

CREATE TRIGGER job_revisions_publish_guard
BEFORE INSERT ON job_revisions
WHEN (SELECT operation FROM mutation_operations WHERE id = NEW.created_by_operation_id) = 'publish'
BEGIN
  SELECT CASE
    WHEN json_type((SELECT frozen_input FROM mutation_operations WHERE id = NEW.created_by_operation_id), '$.expectedDraftVersion') <> 'integer'
      THEN RAISE(ABORT, 'PUBLISH_DRAFT_GUARD_FAILED')
    WHEN json_type((SELECT frozen_input FROM mutation_operations WHERE id = NEW.created_by_operation_id), '$.expectedGeneration') <> 'integer'
      THEN RAISE(ABORT, 'PUBLISH_GENERATION_GUARD_FAILED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN job_drafts AS draft ON draft.job_id = NEW.job_id
      JOIN jobs AS job ON job.id = NEW.job_id
      WHERE operation.id = NEW.created_by_operation_id
        AND draft.version = json_extract(operation.frozen_input, '$.expectedDraftVersion')
        AND job.active_generation = json_extract(operation.frozen_input, '$.expectedGeneration')
        AND NEW.base_generation = job.active_generation
        AND NEW.snapshot_hash = json_extract(operation.frozen_input, '$.snapshotHash')
        AND NEW.asset_manifest_json = json_extract(operation.frozen_input, '$.assetManifestJson')
        AND NEW.parent_revision_id IS job.active_revision_id
        AND NEW.rollback_source_revision_id IS NULL
    ) THEN RAISE(ABORT, 'PUBLISH_STATE_GUARD_FAILED')
  END;
END;

CREATE TRIGGER job_revisions_close_guard
BEFORE INSERT ON job_revisions
WHEN (SELECT operation FROM mutation_operations WHERE id = NEW.created_by_operation_id) = 'close'
BEGIN
  SELECT CASE
    WHEN json_type((SELECT frozen_input FROM mutation_operations WHERE id = NEW.created_by_operation_id), '$.expectedGeneration') <> 'integer'
      THEN RAISE(ABORT, 'CLOSE_GENERATION_GUARD_FAILED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN jobs AS job ON job.id = NEW.job_id
      JOIN job_revisions AS source ON source.id = json_extract(operation.frozen_input, '$.sourceRevisionId')
      WHERE operation.id = NEW.created_by_operation_id
        AND job.active_generation = json_extract(operation.frozen_input, '$.expectedGeneration')
        AND NEW.base_generation = job.active_generation
        AND NEW.parent_revision_id = source.id
        AND job.active_revision_id = source.id
        AND source.job_id = NEW.job_id
        AND source.status = 'open'
        AND source.snapshot_hash = json_extract(operation.frozen_input, '$.sourceSnapshotHash')
        AND source.asset_manifest_json = json_extract(operation.frozen_input, '$.sourceAssetManifestJson')
        AND NEW.asset_manifest_json = source.asset_manifest_json
        AND NEW.status = 'closed'
        AND NEW.rollback_source_revision_id IS NULL
        AND NEW.snapshot_hash = json_extract(operation.frozen_input, '$.snapshotHash')
        AND json_extract(NEW.snapshot_json, '$.closedState') = json_extract(operation.frozen_input, '$.closedState')
        AND json_extract(NEW.snapshot_json, '$.closedAt') = json_extract(operation.frozen_input, '$.closedAt')
        AND json_remove(NEW.snapshot_json, '$.status', '$.closedState', '$.closedAt')
          = json_remove(source.snapshot_json, '$.status', '$.closedState', '$.closedAt')
    ) THEN RAISE(ABORT, 'CLOSE_SOURCE_GUARD_FAILED')
  END;
END;

CREATE TRIGGER job_revisions_rollback_guard
BEFORE INSERT ON job_revisions
WHEN (SELECT operation FROM mutation_operations WHERE id = NEW.created_by_operation_id) = 'rollback'
BEGIN
  SELECT CASE
    WHEN json_type((SELECT frozen_input FROM mutation_operations WHERE id = NEW.created_by_operation_id), '$.expectedGeneration') <> 'integer'
      THEN RAISE(ABORT, 'ROLLBACK_GENERATION_GUARD_FAILED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN jobs AS job ON job.id = NEW.job_id
      JOIN job_revisions AS source ON source.id = json_extract(operation.frozen_input, '$.sourceRevisionId')
      WHERE operation.id = NEW.created_by_operation_id
        AND job.active_generation = json_extract(operation.frozen_input, '$.expectedGeneration')
        AND NEW.base_generation = job.active_generation
        AND NEW.parent_revision_id IS job.active_revision_id
        AND NEW.rollback_source_revision_id = source.id
        AND source.job_id = NEW.job_id
        AND source.snapshot_hash = json_extract(operation.frozen_input, '$.sourceSnapshotHash')
        AND source.asset_manifest_json = json_extract(operation.frozen_input, '$.sourceAssetManifestJson')
        AND NEW.snapshot_json = source.snapshot_json
        AND NEW.snapshot_hash = source.snapshot_hash
        AND NEW.asset_manifest_json = source.asset_manifest_json
        AND NEW.status = source.status
    ) THEN RAISE(ABORT, 'ROLLBACK_SOURCE_GUARD_FAILED')
  END;
END;

CREATE TRIGGER job_revisions_immutable
BEFORE UPDATE ON job_revisions
BEGIN
  SELECT RAISE(ABORT, 'REVISION_IMMUTABLE');
END;

CREATE TRIGGER job_revisions_no_delete
BEFORE DELETE ON job_revisions
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER revision_assets_insert_guard
BEFORE INSERT ON revision_assets
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM job_revisions AS revision
      JOIN mutation_operations AS operation ON operation.id = revision.created_by_operation_id
      JOIN operation_lease_guards AS lease_guard ON lease_guard.operation_id = operation.id
      WHERE revision.id = NEW.revision_id
        AND operation.state = 'pending'
        AND operation.lease_token = lease_guard.expected_lease_token
        AND operation.lease_expires_at = lease_guard.expected_lease_expires_at
    ) THEN RAISE(ABORT, 'REVISION_ASSET_OPERATION_GUARD_FAILED')
    WHEN NOT EXISTS (
      SELECT 1 FROM assets
      WHERE id = NEW.asset_id AND verification_state = 'verified'
    ) THEN RAISE(ABORT, 'REVISION_ASSET_UNVERIFIED')
  END;
END;

CREATE TRIGGER revision_assets_immutable
BEFORE UPDATE ON revision_assets
BEGIN
  SELECT RAISE(ABORT, 'REVISION_ASSET_IMMUTABLE');
END;

CREATE TRIGGER revision_assets_no_delete
BEFORE DELETE ON revision_assets
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER mutation_operations_update_guard
BEFORE UPDATE ON mutation_operations
BEGIN
  SELECT CASE
    WHEN OLD.state IN ('succeeded', 'failed') THEN RAISE(ABORT, 'OPERATION_TERMINAL_IMMUTABLE')
    WHEN NEW.id <> OLD.id
      OR NEW.scope_type <> OLD.scope_type
      OR NEW.scope_id <> OLD.scope_id
      OR NEW.operation <> OLD.operation
      OR NEW.idempotency_key <> OLD.idempotency_key
      OR NEW.fingerprint <> OLD.fingerprint
      OR NEW.frozen_input <> OLD.frozen_input
      OR NEW.actor_subject <> OLD.actor_subject
      OR NEW.environment <> OLD.environment
      OR NEW.retry_of IS NOT OLD.retry_of
      OR NEW.created_at <> OLD.created_at THEN RAISE(ABORT, 'OPERATION_FROZEN_FIELDS_IMMUTABLE')
    WHEN NEW.state NOT IN ('pending', 'succeeded', 'failed') THEN RAISE(ABORT, 'OPERATION_STATE_INVALID')
    WHEN NEW.state = 'pending' AND (
      NEW.terminal_http_status IS NOT NULL
      OR NEW.terminal_code IS NOT NULL
      OR NEW.terminal_body IS NOT NULL
      OR NEW.terminal_correlation_id IS NOT NULL
      OR NEW.terminal_at IS NOT NULL
    ) THEN RAISE(ABORT, 'OPERATION_TERMINAL_FIELDS_INVALID')
    WHEN NEW.state IN ('succeeded', 'failed') AND (
      NEW.terminal_http_status IS NULL
      OR NEW.terminal_code IS NULL
      OR NEW.terminal_body IS NULL
      OR NEW.terminal_correlation_id IS NULL
      OR NEW.terminal_at IS NULL
    ) THEN RAISE(ABORT, 'OPERATION_TERMINAL_FIELDS_REQUIRED')
  END;
END;

CREATE TRIGGER mutation_operations_publish_success_guard
BEFORE UPDATE OF state ON mutation_operations
WHEN OLD.state = 'pending'
  AND NEW.state = 'succeeded'
  AND NEW.operation IN ('publish', 'close', 'rollback')
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_revisions AS revision
    JOIN jobs AS job ON job.active_revision_id = revision.id
    WHERE revision.created_by_operation_id = NEW.id
      AND job.id = revision.job_id
      AND job.active_generation = revision.base_generation + 1
      AND (NEW.result_revision_id IS NULL OR NEW.result_revision_id = revision.id)
  ) THEN RAISE(ABORT, 'OPERATION_PUBLICATION_INCOMPLETE') END;
END;

CREATE TRIGGER mutation_operations_no_delete
BEFORE DELETE ON mutation_operations
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER operation_lease_guards_insert_guard
BEFORE INSERT ON operation_lease_guards
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM mutation_operations
    WHERE id = NEW.operation_id
      AND state = NEW.expected_state
      AND lease_token = NEW.expected_lease_token
      AND lease_expires_at = NEW.expected_lease_expires_at
  ) THEN RAISE(ABORT, 'OPERATION_LEASE_GUARD_FAILED') END;
END;

CREATE TRIGGER operation_lease_guards_immutable
BEFORE UPDATE ON operation_lease_guards
BEGIN
  SELECT RAISE(ABORT, 'OPERATION_LEASE_GUARD_IMMUTABLE');
END;

CREATE TRIGGER operation_lease_guards_no_delete
BEFORE DELETE ON operation_lease_guards
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER operation_asset_guards_insert_guard
BEFORE INSERT ON operation_asset_guards
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN operation_lease_guards AS lease_guard ON lease_guard.operation_id = operation.id
      WHERE operation.id = NEW.operation_id
        AND operation.state = 'pending'
        AND operation.lease_token = lease_guard.expected_lease_token
        AND operation.lease_expires_at = lease_guard.expected_lease_expires_at
    ) THEN RAISE(ABORT, 'OPERATION_ASSET_LEASE_GUARD_FAILED')
    WHEN NOT EXISTS (
      SELECT 1 FROM assets
      WHERE id = NEW.asset_id
        AND verification_state = 'verified'
        AND sha256 = NEW.expected_sha256
        AND detected_mime = NEW.expected_mime
        AND byte_length = NEW.expected_byte_length
    ) THEN RAISE(ABORT, 'OPERATION_ASSET_INTEGRITY_GUARD_FAILED')
    WHEN NEW.require_active_draft_ref = 1 AND NOT EXISTS (
      SELECT 1
      FROM mutation_operations AS operation
      JOIN draft_asset_refs AS draft_ref ON draft_ref.job_id = operation.scope_id
      WHERE operation.id = NEW.operation_id
        AND operation.scope_type = 'job'
        AND draft_ref.asset_id = NEW.asset_id
        AND draft_ref.role = NEW.role
        AND draft_ref.detached_at IS NULL
    ) THEN RAISE(ABORT, 'OPERATION_DRAFT_ASSET_GUARD_FAILED')
  END;
END;

CREATE TRIGGER operation_asset_guards_immutable
BEFORE UPDATE ON operation_asset_guards
BEGIN
  SELECT RAISE(ABORT, 'OPERATION_ASSET_GUARD_IMMUTABLE');
END;

CREATE TRIGGER operation_asset_guards_no_delete
BEFORE DELETE ON operation_asset_guards
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;

CREATE TRIGGER operation_attempts_no_delete
BEFORE DELETE ON operation_attempts
BEGIN
  SELECT RAISE(ABORT, 'NO_PHYSICAL_DELETE');
END;
