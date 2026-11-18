-- REVIEW REQUIRED: run only after Dev migration approval, backup,
-- test suite and maintenance preflight. DO NOT execute on Pro.
--
-- Enables multiple independently verified connection IDs for the same
-- (OAuth owner, provider, namespace) while preserving per-connection
-- immutable primary key, owner checks, credential encryption and grants.
--
-- Preflight:
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid='nyx_storage_verified_identity_v1'::regclass;
--
-- Existing production-type constraint is:
-- nyx_storage_verified_identity_v_owner_id_provider_namespace_key
--
-- This schema change alone MUST NOT make any write/delete action available.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Keep identity lookup efficient after removing unique namespace restriction.
CREATE INDEX IF NOT EXISTS nyx_storage_verified_identity_owner_namespace_idx
  ON nyx_storage_verified_identity_v1 (owner_id, provider, namespace);

ALTER TABLE nyx_storage_verified_identity_v1
  DROP CONSTRAINT IF EXISTS
    nyx_storage_verified_identity_v_owner_id_provider_namespace_key;

COMMIT;

-- Postflight (run separately):
-- SELECT owner_id, provider, namespace, count(*) FROM
-- nyx_storage_verified_identity_v1 GROUP BY 1,2,3 HAVING count(*) > 1;
-- SELECT count(*) FROM nyx_storage_verified_identity_v1;
--
-- Reversal is ONLY valid after verifying no namespace duplicates:
-- ALTER TABLE nyx_storage_verified_identity_v1
-- ADD CONSTRAINT nyx_storage_verified_identity_v_owner_id_provider_namespace_key
-- UNIQUE (owner_id, provider, namespace);
