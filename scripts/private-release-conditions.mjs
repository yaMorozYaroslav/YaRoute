/**
 * Release-only validator for the existing Heroku app.
 * Receives private config through a trusted CI-local file, never prints the
 * values, and never stores them in Git or ChatGPT. Only known conditions are
 * emitted as generic status labels.
 */
export function privateReleaseConditions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['PRIVATE_RUNTIME_CONFIG_INVALID'];
  }
  const errors=[];
  if (config.NYX_DEPLOYMENT_MODE === 'public') errors.push('PUBLIC_RCLONE_RUNTIME_DISABLED');
  const subjects=(config.NYX_PRIVATE_OAUTH_SUBJECTS||'')
    .split(',').map(s=>s.trim()).filter(Boolean);
  if (new Set(subjects).size !== 1 || subjects.length !== 1) {
    errors.push('PRIVATE_OAUTH_REQUIRES_ONE_SUBJECT');
  }
  if (typeof config.DATABASE_URL !== 'string' || !config.DATABASE_URL.trim()) {
    errors.push('NEON_DATABASE_NOT_CONFIGURED');
  }
  if (typeof config.RCLONE_CONFIG_B64 !== 'string' && !config.RCLONE_CONFIG_PATH) {
    errors.push('PRIVATE_RCLONE_CONFIG_NOT_CONFIGURED');
  }
  if(config.NYX_RCLONE_VAULT_ENABLED === 'true'){
    const b64=config.NYX_RCLONE_CREDENTIAL_KEY||'';
    if(!/^[A-Za-z0-9+/]{43}=$/.test(b64) || Buffer.from(b64,'base64').length !== 32) {
      errors.push('RCLONE_VAULT_KEY_NOT_CONFIGURED');
    }
  }
  return errors;
}
