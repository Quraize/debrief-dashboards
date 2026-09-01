-- Uploaded file metadata.
--
-- Files are stored on disk (or object storage later); this table is the only
-- index into them. Two reasons it exists rather than serving a directory:
--
--  * Uploads are spreadsheets of customer appointments — names, phones,
--    addresses. They must never sit behind a guessable public URL, so the id is
--    random and retrieval goes through an authenticated route, not a static path.
--
--  * The import job (Sprint 5) receives a file_url and has to resolve it back to
--    a real path server-side. A row here is that mapping, and it carries who
--    uploaded what, which the audit trail in §5.5 needs.

CREATE TABLE uploaded_file (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- Path on disk, relative to UPLOAD_DIR. Never client-supplied.
  storage_key   text NOT NULL,
  -- The client's filename, kept for display only. Never used to build a path:
  -- that is how directory traversal gets in.
  original_name text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL,
  -- sha256 of the contents, so a re-upload of the same file is detectable and
  -- an import can be tied to exactly the bytes it read.
  checksum      text NOT NULL,
  uploaded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Set when an import consumes it, so orphans can be swept up separately.
  consumed_at   timestamptz,
  CONSTRAINT uploaded_file_size_positive CHECK (size_bytes > 0)
);

CREATE INDEX uploaded_file_uploaded_by_idx ON uploaded_file (uploaded_by, created_at DESC);
CREATE INDEX uploaded_file_orphan_idx      ON uploaded_file (created_at) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON uploaded_file TO allied_app, allied_jobs;
ALTER TABLE uploaded_file ENABLE ROW LEVEL SECURITY;

-- Uploads are an admin/manager activity (importing appointments), and a file is
-- visible to its uploader or a manager. Deletion is deliberately not exposed:
-- removing a file an import may still reference is an operational act.
CREATE POLICY uploaded_file_select ON uploaded_file FOR SELECT
  USING (uploaded_by = allied_current_email() OR allied_is_manager());
CREATE POLICY uploaded_file_insert ON uploaded_file FOR INSERT
  WITH CHECK (allied_is_manager());
CREATE POLICY uploaded_file_update ON uploaded_file FOR UPDATE
  USING (allied_is_manager()) WITH CHECK (allied_is_manager());
