const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { McpAuthService } = require('../dist/mcp/mcp-auth.service');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const issuer = 'https://issuer.example.test';
const audience = 'https://dev-nyx.example.test/mcp';
const environment = [
  'NYX_PUBLIC_URL', 'NYX_OAUTH_ISSUER', 'NYX_OAUTH_AUDIENCE',
  'NYX_OAUTH_SCOPES', 'NYX_PRIVATE_OAUTH_SUBJECTS', 'NYX_DEPLOYMENT_MODE',
  'NYX_PUBLIC_CONNECTORS_ENABLED',
];
const previous = Object.fromEntries(environment.map(key => [key, process.env[key]]));

for (const [key, value] of Object.entries({
  NYX_PUBLIC_URL: 'https://dev-nyx.example.test',
  NYX_OAUTH_ISSUER: issuer,
  NYX_OAUTH_AUDIENCE: audience,
  NYX_OAUTH_SCOPES: 'nyx.read,nyx.write',
  NYX_PRIVATE_OAUTH_SUBJECTS: 'owner-test',
  NYX_DEPLOYMENT_MODE: 'private',
  NYX_PUBLIC_CONNECTORS_ENABLED: 'false',
})) process.env[key] = value;

test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function token(expiresIn = 3600) {
  return jwt.sign({ sub: 'owner-test', scope: 'nyx.read nyx.write' }, privateKey, {
    algorithm: 'RS256', issuer, audience, expiresIn, keyid: 'signing-key-1',
  });
}

function response() {
  return {
    statusCode: 200, headers: {}, locals: {}, body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function authWithKeyProvider(getSigningKey) {
  const auth = new McpAuthService();
  // A local fake ensures this suite never makes issuer/JWKS network requests.
  auth.client = { getSigningKey };
  return auth;
}

async function request(auth, accessToken = token()) {
  const res = response();
  const allowed = await auth.authorize({ headers: { authorization: `Bearer ${accessToken}` } }, res);
  return { allowed, res };
}

test('transient JWKS failure is a closed 503 without a forced login challenge', async t => {
  const failures = [
    Object.assign(new Error('rate limited'), { name: 'JwksRateLimitError' }),
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('issuer unavailable'), { statusCode: 503 }),
  ];
  for (const failure of failures) {
    await t.test(failure.name || failure.code || String(failure.statusCode), async () => {
      const auth = authWithKeyProvider((_kid, callback) => callback(failure));
      const { allowed, res } = await request(auth);
      assert.equal(allowed, false);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.error, 'temporarily_unavailable');
      assert.equal(res.headers['retry-after'], '15');
      assert.equal(res.headers['www-authenticate'], undefined);
    });
  }
});

test('missing signing key and expired token retain a proper 401 challenge', async () => {
  const missing = authWithKeyProvider((_kid, callback) =>
    callback(Object.assign(new Error('unknown kid'), { name: 'SigningKeyNotFoundError' })));
  const missingResult = await request(missing);
  assert.equal(missingResult.allowed, false);
  assert.equal(missingResult.res.statusCode, 401);
  assert.match(missingResult.res.headers['www-authenticate'], /error="invalid_token"/);

  const validKeys = authWithKeyProvider((_kid, callback) =>
    callback(null, { getPublicKey: () => publicKey }));
  const expired = await request(validKeys, token(-60));
  assert.equal(expired.allowed, false);
  assert.equal(expired.res.statusCode, 401);
  assert.match(expired.res.headers['www-authenticate'], /error="invalid_token"/);
});

test('a recovered key provider accepts the same valid login and owner restrictions', async () => {
  let temporarilyUnavailable = true;
  const auth = authWithKeyProvider((_kid, callback) => {
    if (temporarilyUnavailable) callback(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    else callback(null, { getPublicKey: () => publicKey });
  });
  const accessToken = token();
  assert.equal((await request(auth, accessToken)).res.statusCode, 503);
  temporarilyUnavailable = false;
  const recovered = await request(auth, accessToken);
  assert.equal(recovered.allowed, true);
  assert.equal(recovered.res.locals.nyxSubject, 'owner-test');

  process.env.NYX_PRIVATE_OAUTH_SUBJECTS = 'someone-else';
  try {
    const unauthorized = await request(auth, accessToken);
    assert.equal(unauthorized.allowed, false);
    assert.equal(unauthorized.res.statusCode, 403);
  } finally {
    process.env.NYX_PRIVATE_OAUTH_SUBJECTS = 'owner-test';
  }
});
