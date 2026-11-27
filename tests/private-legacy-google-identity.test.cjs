const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const jwt = require('jsonwebtoken');
const {
  PrivateLegacyGoogleIdTokenVerifier,
} = require('../dist/connectors/private-legacy-google-identity');
const {
  mayUsePrivateLegacyRclone,
} = require('../dist/connectors/private-legacy-access.policy');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const expected = {
  clientId: 'test-nyx-client.apps.googleusercontent.com',
  nonce: 'nonce-with-at-least-twenty-chars-123',
};
const verifier = new PrivateLegacyGoogleIdTokenVerifier(async kid => {
  if (kid !== 'google-key-1') throw new Error('unknown signing key');
  return publicKey;
});
const links = [
  { mcpIssuer: 'https://auth.example.test', mcpSubject: 'mcp-one',
    googleSubject: 'google-one', googleEmail: 'owner-one@example.com' },
  { mcpIssuer: 'https://auth.example.test', mcpSubject: 'mcp-two',
    googleSubject: 'google-two', googleEmail: 'owner-two@example.com' },
];

function idToken(claims = {}, options = {}) {
  const payload = {
    sub: 'google-one',
    email: 'owner-one@example.com',
    email_verified: true,
    nonce: expected.nonce,
    ...claims,
  };
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    issuer: 'https://accounts.google.com',
    audience: expected.clientId,
    expiresIn: 300,
    keyid: 'google-key-1',
    ...options,
  });
}
async function denied(token, config = expected) {
  await assert.rejects(() => verifier.verify(token, config),
    { message: 'PRIVATE_GOOGLE_ID_TOKEN_INVALID' });
}
const mcp = subject => ({ issuer: 'https://auth.example.test', subject });

test('valid signed Google ID tokens permit only their linked MCP owner', async () => {
  const one = await verifier.verify(idToken({ email: 'OWNER-ONE@example.com' }), expected);
  const two = await verifier.verify(idToken({
    sub: 'google-two', email: 'owner-two@example.com',
  }), expected);
  const approvedEmail = 'owner-one@example.com';
  assert.equal(one.email, approvedEmail);
  assert.equal(mayUsePrivateLegacyRclone(mcp('mcp-one'), one, [links[0]], approvedEmail), true);
  assert.equal(mayUsePrivateLegacyRclone(mcp('mcp-two'), two, [links[1]], approvedEmail), false);
  assert.equal(mayUsePrivateLegacyRclone(mcp('mcp-one'), one, links, approvedEmail), false);
  assert.equal(mayUsePrivateLegacyRclone(mcp('mcp-one'), two, [links[0]], approvedEmail), false);
  assert.equal(mayUsePrivateLegacyRclone(mcp('public-user'), one, [links[0]], approvedEmail), false);
  assert.equal(mayUsePrivateLegacyRclone(null, one, [links[0]], approvedEmail), false);
});

test('matching email with a different Google subject cannot claim operator Rclone', async () => {
  const imposter = await verifier.verify(idToken({ sub: 'other-google-sub' }), expected);
  assert.equal(mayUsePrivateLegacyRclone(mcp('mcp-one'), imposter, [links[0]], 'owner-one@example.com'), false);
});

test('unsigned identity fields, wrong signature and non-RS256 signing are denied', async () => {
  const forged = jwt.sign({
    sub: 'google-one', email: 'owner-one@example.com', email_verified: true,
    nonce: expected.nonce,
  }, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, {
    algorithm: 'RS256', issuer: 'https://accounts.google.com',
    audience: expected.clientId, expiresIn: 300, keyid: 'google-key-1',
  });
  await denied(forged);
  await denied(jwt.sign({ sub: 'google-one', nonce: expected.nonce }, 'unsafe-test-key', {
    algorithm: 'HS256', issuer: 'https://accounts.google.com',
    audience: expected.clientId, expiresIn: 300,
  }));
  await denied('not.a.valid.jwt');
});

test('wrong nonce, client audience, issuer and key ID fail closed', async () => {
  await denied(idToken({ nonce: 'another-unique-long-nonce-123456' }));
  await denied(idToken(), { ...expected, nonce: 'wrong-stored-nonce-12345678901' });
  await denied(idToken(), { ...expected, clientId: 'another-client.apps.googleusercontent.com' });
  await denied(idToken({}, { issuer: 'https://evil.example.test' }));
  await denied(idToken({}, { keyid: 'unknown-google-key' }));
  await denied(idToken({ azp: 'different-client.apps.googleusercontent.com' }));
});

test('Google email must be both cryptographically attested and verified', async () => {
  await denied(idToken({ email_verified: false }));
  await denied(idToken({ email_verified: 'true' }));
  await denied(idToken({ email: 'owner-one@example.com', email_verified: null }));
  await denied(idToken({ email: 'bad-email' }));
  await denied(idToken({ sub: '' }));
});

test('expired and stale login proofs are denied; configuration is mandatory', async () => {
  await denied(idToken({}, { expiresIn: -60 }));
  await denied(idToken({ iat: Math.floor(Date.now() / 1000) - 900 }, { expiresIn: 3600 }));
  await denied(idToken(), { ...expected, nonce: 'too-short' });
  await denied(idToken(), { ...expected, clientId: '' });
});

test('the verifier never invokes the network for a rejected key lookup', async () => {
  const noKeys = new PrivateLegacyGoogleIdTokenVerifier(async () => {
    throw new Error('offline signing keys');
  });
  await assert.rejects(() => noKeys.verify(idToken(), expected),
    { message: 'PRIVATE_GOOGLE_ID_TOKEN_INVALID' });
});
