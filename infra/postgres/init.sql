-- Application role: cannot own tables, so Row-Level Security always applies to it.
CREATE ROLE workeasy_app LOGIN PASSWORD 'workeasy_app' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE workeasy TO workeasy_app;
GRANT USAGE ON SCHEMA public TO workeasy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE workeasy IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workeasy_app;
ALTER DEFAULT PRIVILEGES FOR ROLE workeasy IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO workeasy_app;
