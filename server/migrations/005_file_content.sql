-- Uploaded file contents kept in the database, for hosts without a lasting disk (e.g. Vercel).
-- Empty when files are stored on the server's disk (STORAGE_DIR).
ALTER TABLE files ADD COLUMN content bytea;
