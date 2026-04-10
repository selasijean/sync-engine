-- 001_initial.sql
-- Run with: psql -f migrations/001_initial.sql

-- Enable logical replication (run as superuser if not already set)
-- ALTER SYSTEM SET wal_level = logical;

-- ============================================================================
-- Changelog table — the append-only log that powers the sync engine.
--
-- Every mutation in the system produces a row here. The client's lastSyncId
-- corresponds to changelog.id. LISTEN/NOTIFY on this table drives real-time
-- delta delivery to all connected SSE clients.
-- ============================================================================

CREATE TABLE IF NOT EXISTS changelog (
    id          BIGSERIAL PRIMARY KEY,          -- this IS the syncId
    model_name  TEXT        NOT NULL,           -- e.g. "Issue", "Team", "Receipt"
    model_id    UUID        NOT NULL,           -- the entity's UUID
    action      CHAR(1)     NOT NULL,           -- I=insert, U=update, D=delete, A=archive
    data        JSONB,                          -- full row snapshot for I/U, null for D
    sync_groups TEXT[]      NOT NULL DEFAULT '{}', -- tenant/team/user scoping
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_changelog_created   ON changelog (created_at);
CREATE INDEX IF NOT EXISTS idx_changelog_groups    ON changelog USING GIN (sync_groups);
CREATE INDEX IF NOT EXISTS idx_changelog_model     ON changelog (model_name, model_id);

-- ============================================================================
-- Notify function — fires on every changelog INSERT.
-- The payload is just the changelog ID. The Go listener queries the full row.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_changelog_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('changelog_changes', NEW.id::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS changelog_notify ON changelog;
CREATE TRIGGER changelog_notify
    AFTER INSERT ON changelog
    FOR EACH ROW
    EXECUTE FUNCTION notify_changelog_change();

-- ============================================================================
-- Sync metadata — tracks server-side schema version and other global state.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

INSERT INTO sync_meta (key, value) VALUES
    ('database_version', '1'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Example model tables. Replace these with your actual domain models.
-- The Go server reads from these when building bootstrap responses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    key         TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    priority    INT  NOT NULL DEFAULT 0,
    sort_order  INT  NOT NULL DEFAULT 0,
    team_id     UUID REFERENCES teams(id),
    assignee_id UUID REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issues_team     ON issues (team_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues (assignee_id);
