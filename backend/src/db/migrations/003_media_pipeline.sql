-- 003 — media pipeline: renditions produced by MediaConvert/ffmpeg and the jobs that made them.

DO $$ BEGIN
  CREATE TYPE asset_kind AS ENUM ('source', 'hls', 'poster', 'backdrop', 'preview', 'caption');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE asset_status AS ENUM ('pending', 'available', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transcode_status AS ENUM ('queued', 'submitted', 'processing', 'succeeded', 'failed', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id         uuid NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  kind             asset_kind NOT NULL,
  storage_driver   text NOT NULL DEFAULT 'local',
  bucket           text,
  storage_key      text NOT NULL,
  rendition        text,
  width            integer,
  height           integer,
  bitrate_kbps     integer,
  size_bytes       bigint,
  duration_seconds integer,
  content_type     text,
  status           asset_status NOT NULL DEFAULT 'pending',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One asset per (title, kind, rendition); rendition is NULL for source/poster rows,
-- so the uniqueness is expressed on an expression index rather than a plain constraint.
CREATE UNIQUE INDEX IF NOT EXISTS assets_unique_idx
  ON assets (title_id, kind, coalesce(rendition, ''));
CREATE INDEX IF NOT EXISTS assets_title_idx ON assets (title_id);

DROP TRIGGER IF EXISTS assets_set_updated_at ON assets;
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS transcode_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id         uuid NOT NULL REFERENCES titles (id) ON DELETE CASCADE,
  provider         text NOT NULL,             -- ffmpeg | mediaconvert
  external_job_id  text,                      -- MediaConvert job id
  status           transcode_status NOT NULL DEFAULT 'queued',
  progress         integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  input_key        text NOT NULL,
  output_prefix    text NOT NULL,
  error_message    text,
  attempts         integer NOT NULL DEFAULT 0,
  submitted_at     timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcode_jobs_status_idx ON transcode_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS transcode_jobs_title_idx ON transcode_jobs (title_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transcode_jobs_external_idx ON transcode_jobs (external_job_id);

DROP TRIGGER IF EXISTS transcode_jobs_set_updated_at ON transcode_jobs;
CREATE TRIGGER transcode_jobs_set_updated_at BEFORE UPDATE ON transcode_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
