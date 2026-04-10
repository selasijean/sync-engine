DROP TABLE IF EXISTS issues;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS sync_meta;
DROP TRIGGER IF EXISTS changelog_notify ON changelog;
DROP FUNCTION IF EXISTS notify_changelog_change;
DROP TABLE IF EXISTS changelog;
