import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIndex} from '../scripts/nyx-repair-pending-index.mjs';

test('legacy index must be reported before permitting multi-remote batches',()=>{
  const old="CREATE UNIQUE INDEX nyx_rclone_owner_remote_uq ON public.nyx_connector_connections USING btree (owner_id, provider, external_account_id) WHERE ((provider = ANY (ARRAY['google-drive'::text, 'mega'::text])) AND (status <> 'revoked'::text))";
  assert.equal(classifyIndex(old),'legacy');
});
test('active-only unique index keeps real provider identities unique while allowing multiple pending',()=>{
  const repaired="CREATE UNIQUE INDEX nyx_rclone_owner_remote_uq ON public.nyx_connector_connections USING btree (owner_id, provider, external_account_id) WHERE ((provider = ANY (ARRAY['google-drive'::text, 'mega'::text])) AND (status = 'active'::text))";
  assert.equal(classifyIndex(repaired),'active_only');
  assert.equal(classifyIndex(null),'missing');
});
test('unexpected index definitions fail closed',()=>{
  assert.equal(classifyIndex('DROP INDEX nyx_rclone_owner_remote_uq'),'unexpected');
  assert.equal(classifyIndex("CREATE UNIQUE INDEX nyx_rclone_owner_remote_uq ON public.nyx_connector_connections USING btree (provider, external_account_id) WHERE status='active'"),'unexpected');
});
