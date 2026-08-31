-- The migration runner scrubs legacy JSON fields transactionally before this
-- migration is marked applied. Keeping this marker in the normal migration
-- sequence makes the cleanup run once on existing Cloud databases.
SELECT 1;
