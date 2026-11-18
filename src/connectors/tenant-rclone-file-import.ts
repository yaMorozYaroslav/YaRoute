import type { TenantRcloneProfile, TenantRcloneProvider } from './tenant-rclone.service';

/**
 * Extract ONE selected remote from a user-supplied local Rclone INI file.
 * Never return any other remote, expose credentials in errors, or use process-global Rclone.
 */
export function parseSelectedLocalRclone(
  contents: string,
  remoteName: string,
  provider: TenantRcloneProvider,
  rootId: string,
): TenantRcloneProfile {
  if (typeof contents !== 'string' || contents.length < 10 || contents.length > 65536 ||
      contents.includes('\0') || typeof remoteName !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(remoteName))
    throw new Error('RCLONE_IMPORT_FILE_INVALID');
  if (provider !== 'mega' && provider !== 'google-drive')
    throw new Error('RCLONE_IMPORT_PROVIDER_INVALID');
  if (typeof rootId !== 'string' || rootId.length < 1 || rootId.length > 256 ||
      !/^[A-Za-z0-9_.\/-]+$/.test(rootId) || rootId.startsWith('/') ||
      rootId.split('/').some(x => x === '.' || x === '..'))
    throw new Error('RCLONE_IMPORT_ROOT_INVALID');

  const values: Record<string,string> = {};
  let selected = false, sections = 0;
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const section = /^\[([A-Za-z][A-Za-z0-9_.-]{0,119})\]$/.exec(trimmed);
    if (section) {
      selected = section[1] === remoteName;
      if (selected) sections++;
      continue;
    }
    // Refuse malformed section syntax even in unselected remotes.
    if (trimmed.startsWith('[')) throw new Error('RCLONE_IMPORT_FORMAT_INVALID');
    if (!selected) continue;
    const m = /^([a-z][a-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!m || Object.prototype.hasOwnProperty.call(values,m[1]))
      throw new Error('RCLONE_IMPORT_FORMAT_INVALID');
    values[m[1]] = m[2];
  }
  if (sections !== 1) throw new Error('RCLONE_IMPORT_REMOTE_NOT_UNIQUE');
  if (values.type !== (provider === 'google-drive' ? 'drive' : 'mega'))
    throw new Error('RCLONE_IMPORT_PROVIDER_MISMATCH');

  const allowed = provider === 'google-drive'
    ? new Set(['type','token','client_id','client_secret','root_folder_id','team_drive','scope'])
    : new Set(['type','user','pass','session_id','master_key']);
  if (Object.keys(values).some(k => !allowed.has(k)))
    throw new Error('RCLONE_IMPORT_OPTION_UNSUPPORTED');
  const safe = (value: string | undefined, max = 32768) => {
    if (typeof value !== 'string' || !value || value.length > max ||
        /[\x00\r\n]/.test(value))
      throw new Error('RCLONE_IMPORT_FIELD_INVALID');
    return value;
  };

  if (provider === 'google-drive') {
    if (values.type !== 'drive') throw new Error('RCLONE_IMPORT_PROVIDER_MISMATCH');
    const token = safe(values.token);
    let payload: unknown;
    try { payload = JSON.parse(token); } catch {throw new Error('RCLONE_IMPORT_DRIVE_TOKEN_INVALID');}
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !('access_token' in payload || 'refresh_token' in payload))
      throw new Error('RCLONE_IMPORT_DRIVE_TOKEN_INVALID');
    const actualRoot = values.root_folder_id || 'root';
    if (actualRoot !== rootId) throw new Error('RCLONE_IMPORT_DRIVE_ROOT_MISMATCH');
    const profile: Extract<TenantRcloneProfile,{provider:'google-drive'}> = {
      provider:'google-drive',token,rootFolderId:rootId,
    };
    if (!values.root_folder_id) profile.accountRoot = true;
    if (values.team_drive) profile.teamDriveId = safe(values.team_drive,256);
    if (values.client_id) profile.clientId = safe(values.client_id,2048);
    if (values.client_secret) profile.clientSecret = safe(values.client_secret,2048);
    if (values.scope) {
      const scope = values.scope;
      if (scope !== 'drive' && scope !== 'drive.file' && scope !== 'drive.readonly')
        throw new Error('RCLONE_IMPORT_DRIVE_SCOPE_UNSUPPORTED');
      profile.scope = scope;
    }
    return profile;
  }

  if (values.type !== 'mega') throw new Error('RCLONE_IMPORT_PROVIDER_MISMATCH');
  if (rootId !== 'MEGA_ROOT') throw new Error('RCLONE_IMPORT_MEGA_ROOT_UNSUPPORTED');
  if (Boolean(values.session_id) !== Boolean(values.master_key))
    throw new Error('RCLONE_IMPORT_MEGA_SESSION_INCOMPLETE');
  const profile: Extract<TenantRcloneProfile,{provider:'mega'}> = {
    provider:'mega',user:safe(values.user,512),obscuredPassword:safe(values.pass,8192),
  };
  if (values.session_id) {
    profile.sessionId = safe(values.session_id,4096);
    profile.masterKey = safe(values.master_key,4096);
  }
  return profile;
}


export interface LocalRcloneBatchItem {
  name: string;
  provider: TenantRcloneProvider;
  rootId: string;
  profile: TenantRcloneProfile;
}
export interface LocalRcloneBatch {
  items: LocalRcloneBatchItem[];
  unsupported: string[];
  rejected: {name:string; reason:string}[];
}

/** Inspect all sections without accepting names, arbitrary options or credentials as authority. */
export function parseLocalRcloneBatch(contents: string): LocalRcloneBatch {
  if(typeof contents!=='string'||contents.length<10||contents.length>65536||
     contents.includes('\0'))throw new Error('RCLONE_BATCH_FILE_INVALID');
  const byName = new Map<string,{name:string;lines:string[]}>();
  let current: {name:string;lines:string[]} | undefined;
  const lines=contents.split(/\r?\n/);
  for(const line of lines) {
    const t=line.trim();
    if(!t||t.startsWith('#')||t.startsWith(';')) {
      if(current)current.lines.push(line);
      continue;
    }
    if(t.startsWith('[')) {
      const match=/^\[([A-Za-z][A-Za-z0-9_.-]{0,79})\]$/.exec(t);
      if(!match)throw new Error('RCLONE_BATCH_SECTION_INVALID');
      const key=match[1].toLowerCase();
      if(byName.has(key))throw new Error('RCLONE_BATCH_DUPLICATE_REMOTE');
      current={name:match[1],lines:[t]};
      byName.set(key,current);
      if(byName.size>24)throw new Error('RCLONE_BATCH_REMOTE_LIMIT');
    } else if(current) current.lines.push(line);
    else throw new Error('RCLONE_BATCH_FORMAT_INVALID');
  }
  const items:LocalRcloneBatchItem[]=[];
  const unsupported:string[]=[];
  const rejected:{name:string;reason:string}[]=[];
  for(const item of byName.values()) {
    const typeLines=item.lines.filter(line=>/^\s*type\s*=/.test(line));
    if(typeLines.length!==1) {
      rejected.push({name:item.name,reason:'invalid_provider_type'});continue;
    }
    const kind=typeLines[0].split('=').slice(1).join('=').trim();
    if(kind!=='drive'&&kind!=='mega') {
      unsupported.push(item.name);continue;
    }
    const provider:TenantRcloneProvider=kind==='drive'?'google-drive':'mega';
    const rootLines=item.lines.filter(line=>/^\s*root_folder_id\s*=/.test(line));
    if(rootLines.length>1){rejected.push({name:item.name,reason:'invalid_root'});continue;}
    const rootId=provider==='mega'?'MEGA_ROOT':
      rootLines.length===1?rootLines[0].split('=').slice(1).join('=').trim():'root';
    try {
      const profile=parseSelectedLocalRclone(
        item.lines.join('\n'),item.name,provider,rootId);
      items.push({name:item.name,provider,rootId,profile});
    } catch {
      rejected.push({name:item.name,reason:'unsupported_or_invalid_profile'});
    }
  }
  if(items.length>12)throw new Error('RCLONE_BATCH_SUPPORTED_REMOTE_LIMIT');
  return {items,unsupported,rejected};
}
