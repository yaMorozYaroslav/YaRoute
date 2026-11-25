const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GithubWriteConnector } = require('../dist/connectors/github-writes');

function fixture(status, headers = {}) {
  const requests = [];
  const registry = { requireResource: async (_owner, _id, capability, scope) => {
    assert.equal(scope.id, 'yaMorozYaroslav/MyWeb');
    assert.ok(['contents:write','pulls:write'].includes(capability));
    return { provider: 'github', installationId: '123' };
  }};
  const credentials = { tokenFor: async () => 'mock-token' };
  const http = async (url, options) => {
    requests.push({ method: options.method, url });
    if (options.method === 'GET') return {
      ok: true, status: 200, text: async () => JSON.stringify({default_branch:'master'}),
    };
    return {
      ok: false, status,
      headers: { get: key => headers[key] ?? null },
      text: async () => JSON.stringify({message:'SENSITIVE_DO_NOT_ECHO'}),
    };
  };
  return { writes: new GithubWriteConnector(registry, credentials, http), requests };
}

test('GitHub content write 422 reports safe validation failure, never provider response', async () => {
  const { writes, requests } = fixture(422);
  await assert.rejects(
    writes.commitFile('oauth:owner','connection','yaMorozYaroslav/MyWeb',
      'nyx/review-test','src/Comps/Contacts/Contacts.module.css','a{}','Update CSS',
      'e3190e3e5c2d289e8db817963d3c3a6c90c77214'),
    error => { assert.equal(error.message, 'GITHUB_PROVIDER_VALIDATION_FAILED');
      assert.doesNotMatch(error.message,/SENSITIVE|mock-token/); return true; });
  assert.deepEqual(requests.map(r=>r.method), ['GET','PUT']);
});

test('PR creation 403 reports permission category without leaking provider details', async () => {
  const { writes, requests } = fixture(403);
  await assert.rejects(
    writes.draftPullToNonDefault('oauth:owner','connection','yaMorozYaroslav/MyWeb',
      'nyx/review-test','tester','Review safe patch',''),
    /GITHUB_PROVIDER_FORBIDDEN/);
  assert.deepEqual(requests.map(r=>r.method), ['GET','POST']);
});

test('Rate limit and provider outage are distinguished without unsafe retries', async () => {
  for (const [status,headers,code] of [
    [429,{},'GITHUB_PROVIDER_RATE_LIMITED'],
    [403,{'x-ratelimit-remaining':'0'},'GITHUB_PROVIDER_RATE_LIMITED'],
    [503,{},'GITHUB_PROVIDER_TEMPORARY_FAILURE'],
    [401,{},'GITHUB_PROVIDER_UNAUTHORIZED'],
  ]) {
    const { writes, requests } = fixture(status, headers);
    await assert.rejects(
      writes.draftPullToNonDefault('oauth:owner','connection','yaMorozYaroslav/MyWeb',
        'nyx/review-test','tester','Review safe patch',''),
      error => { assert.equal(error.message,code); return true; });
    assert.equal(requests.filter(r=>r.method==='POST').length,1,
      'potentially non-idempotent GitHub writes must not silently retry');
  }
});
