const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mayUsePrivateLegacyRclone } = require('../dist/connectors/private-legacy-access.policy');

// Synthetic identities only. The real approved email and Google subject must
// be provisioned privately by the operator, never embedded in this repository.
const approvedEmail = 'sole-owner@example.com';
const owner = {
  mcpIssuer: 'https://auth.example.test', mcpSubject: 'mcp-owner',
  googleSubject: 'google-owner', googleEmail: approvedEmail,
};
const former = {
  mcpIssuer: 'https://auth.example.test', mcpSubject: 'mcp-former',
  googleSubject: 'google-former', googleEmail: 'former-owner@example.com',
};
const actor = (subject = 'mcp-owner') => ({ issuer: 'https://auth.example.test', subject });
const google = (subject = 'google-owner', email = approvedEmail) => ({
  issuer: 'https://accounts.google.com', subject, email, emailVerified: true,
});
const allow = (mcp = actor(), identity = google(), links = [owner], email = approvedEmail) =>
  mayUsePrivateLegacyRclone(mcp, identity, links, email);

test('one verified and explicitly approved Google account may access private legacy Rclone', () => {
  assert.equal(allow(), true);
  assert.equal(allow(actor(), google('google-owner', 'SOLE-OWNER@example.com')), true);
});

test('former second owner is denied even with a previously allowed two-owner registry', () => {
  assert.equal(allow(actor('mcp-former'),
    google('google-former', 'former-owner@example.com'), [former]), false);
  assert.equal(allow(actor(), google(), [owner, former]), false);
  assert.equal(allow(actor(), google(), [former, owner]), false);
  assert.equal(allow(actor(), google(), [owner, owner]), false);
  assert.equal(allow(actor(), google(), []), false);
});

test('missing or mismatched protected approved-email configuration denies access', () => {
  assert.equal(mayUsePrivateLegacyRclone(actor(), google(), [owner], undefined), false);
  assert.equal(allow(actor(), google(), [owner], ''), false);
  assert.equal(allow(actor(), google(), [owner], 'other@example.com'), false);
  assert.equal(allow(actor(), google(), [{ ...owner, googleEmail: 'other@example.com' }]), false);
});

test('public or anonymous MCP users cannot claim approved Google storage', () => {
  assert.equal(allow(actor('public-user')), false);
  assert.equal(allow(null), false);
  assert.equal(allow(actor(), null), false);
  assert.equal(allow({ issuer: 'https://evil.example.test', subject: 'mcp-owner' }), false);
});

test('unverified or impersonated Google identities cannot access private storage', () => {
  assert.equal(allow(actor(), { ...google(), emailVerified: false }), false);
  assert.equal(allow(actor(), google('imposter-sub', approvedEmail)), false);
  assert.equal(allow(actor(), google('google-owner', 'other@example.com')), false);
  assert.equal(allow(actor(), { ...google(), issuer: 'https://evil.example.test' }), false);
  assert.equal(allow(actor(), google('google-former', 'former-owner@example.com')), false);
});

test('malformed owner links cannot grant access', () => {
  assert.equal(allow(actor(), google(), [{ ...owner, googleEmail: 'invalid-email' }]), false);
  assert.equal(allow(actor(), google(), [{ ...owner, googleSubject: '' }]), false);
  assert.equal(allow(actor(), google(), [{ ...owner, mcpIssuer: 'http://auth.example.test' }]), false);
});
