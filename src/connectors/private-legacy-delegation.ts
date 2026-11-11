import { createHmac, timingSafeEqual } from 'node:crypto';

/** Dedicated service-to-service proof. Never contains a provider token or Rclone secret. */
export type PrivateBrokerOperation = 'roots' | 'list';
export interface PrivateBrokerClaims {
  v: 1;
  iss: string;
  aud: string;
  mcpIssuer: string;
  mcpSubject: string;
  googleSubject: string;
  op: PrivateBrokerOperation;
  root: string;
  path: string;
  jti: string;
  iat: number;
  exp: number;
}
export interface PrivateBrokerExpected {
  issuer: string;
  audience: string;
  mcpIssuer: string;
  mcpSubject: string;
  googleSubject: string;
}
const claimKeys = ['aud','exp','googleSubject','iat','iss','jti','mcpIssuer',
  'mcpSubject','op','path','root','v'].sort().join(',');

export function privateBrokerKey(base64: string): Buffer {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(base64))
    throw new Error('PRIVATE_BROKER_KEY_INVALID');
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== base64)
    throw new Error('PRIVATE_BROKER_KEY_INVALID');
  return key;
}
export function privateBrokerPath(path: string): string {
  if (typeof path !== 'string' || path.length > 1024 || path.startsWith('/') ||
      /[:\\\x00-\x1f]/.test(path) ||
      path.split('/').some(part => part === '..' || part === '.'))
    throw new Error('PRIVATE_BROKER_PATH_DENIED');
  return path;
}
export function privateBrokerRoot(root: string): string {
  if (typeof root !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(root))
    throw new Error('PRIVATE_BROKER_ROOT_INVALID');
  return root;
}
function valid(claims: PrivateBrokerClaims, now: number): boolean {
  return claims && typeof claims === 'object' &&
    Object.keys(claims).sort().join(',') === claimKeys &&
    claims.v === 1 &&
    ['roots','list'].includes(claims.op) &&
    typeof claims.iss === 'string' && claims.iss.length > 8 &&
    typeof claims.aud === 'string' && claims.aud.length > 8 &&
    typeof claims.mcpIssuer === 'string' && claims.mcpIssuer.length > 8 &&
    typeof claims.mcpSubject === 'string' && claims.mcpSubject.length > 0 &&
    claims.mcpSubject.length <= 500 &&
    typeof claims.googleSubject === 'string' && claims.googleSubject.length > 0 &&
    claims.googleSubject.length <= 255 &&
    typeof claims.root === 'string' && typeof claims.path === 'string' &&
    (claims.op === 'roots' ? claims.root === '' && claims.path === '' :
      /^[A-Z][A-Z0-9_]{0,39}$/.test(claims.root) &&
      claims.path.length <= 1024 && !claims.path.startsWith('/') &&
      !/[:\\\x00-\x1f]/.test(claims.path) &&
      claims.path.split('/').every(p => p !== '.' && p !== '..')) &&
    typeof claims.jti === 'string' && /^[a-f0-9]{32}$/.test(claims.jti) &&
    Number.isInteger(claims.iat) && Number.isInteger(claims.exp) &&
    claims.iat >= now - 45 && claims.iat <= now + 5 &&
    claims.exp > now && claims.exp <= claims.iat + 45;
}
export function signPrivateBrokerDelegation(
  claims: PrivateBrokerClaims, keyB64: string, now = Math.floor(Date.now()/1000),
): string {
  if (!valid(claims, now)) throw new Error('PRIVATE_BROKER_CLAIMS_INVALID');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const mac = createHmac('sha256', privateBrokerKey(keyB64)).update(body).digest('base64url');
  return body + '.' + mac;
}
export function verifyPrivateBrokerDelegation(
  token: string, keyB64: string, expected: PrivateBrokerExpected,
  now = Math.floor(Date.now()/1000),
): PrivateBrokerClaims {
  if (typeof token !== 'string' || token.length > 5000 ||
      !/^[A-Za-z0-9_-]{40,4500}\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('PRIVATE_BROKER_TOKEN_DENIED');
  const [body, mac] = token.split('.');
  const signature = createHmac('sha256', privateBrokerKey(keyB64)).update(body).digest();
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.length !== signature.length ||
      !timingSafeEqual(supplied, signature) ||
      supplied.toString('base64url') !== mac)
    throw new Error('PRIVATE_BROKER_TOKEN_DENIED');
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) throw new Error('PRIVATE_BROKER_TOKEN_DENIED');
  let claims: PrivateBrokerClaims;
  try { claims = JSON.parse(bytes.toString('utf8')) as PrivateBrokerClaims; }
  catch { throw new Error('PRIVATE_BROKER_TOKEN_DENIED'); }
  if (!valid(claims,now) || claims.iss !== expected.issuer ||
      claims.aud !== expected.audience ||
      claims.mcpIssuer !== expected.mcpIssuer ||
      claims.mcpSubject !== expected.mcpSubject ||
      claims.googleSubject !== expected.googleSubject)
    throw new Error('PRIVATE_BROKER_TOKEN_DENIED');
  return claims;
}
