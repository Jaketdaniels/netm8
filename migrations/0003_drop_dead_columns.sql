-- Remove columns and table left over from the linear 5-stage pipeline.
-- The iterative operations loop (SpawnAgent) does not use them.

ALTER TABLE spawns DROP COLUMN stage;
ALTER TABLE spawns DROP COLUMN architecture;
ALTER TABLE spawn_files DROP COLUMN stage;

DROP TABLE IF EXISTS spawn_stages;
