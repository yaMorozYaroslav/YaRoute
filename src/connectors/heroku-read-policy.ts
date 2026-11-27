/**
 * Additional closed-by-default authorization for Heroku metadata reads.
 * Only an authenticated single owner, an exact broker connection ID and
 * exact approved apps are accepted. The independent broker independently
 * checks owner+connection+app; no broad bearer token reaches NestNyx.
 */
const APP=/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function herokuReadAuthorization(ownerId:string,app:string,
  env:Readonly<Record<string,string|undefined>>=process.env){
  if(env.NYX_HEROKU_READ_ENABLED!=='true')
    throw new Error('HEROKU_READ_NOT_ENABLED');
  const allowedOwner=env.NYX_HEROKU_READ_OWNER||'';
  const id=env.NYX_HEROKU_READ_CONNECTION_ID||'';
  const raw=env.NYX_HEROKU_READ_APPS||'';
  const list=raw.split(',').map(s=>s.trim());
  if(!/^oauth:[^\x00-\x1f]{1,500}$/.test(allowedOwner)||
    !UUID.test(id)||list.length<1||list.length>8||
    list.some(s=>!APP.test(s))||new Set(list).size!==list.length)
    throw new Error('HEROKU_READ_GRANTS_INVALID');
  if(ownerId!==allowedOwner||!APP.test(app)||!list.includes(app))
    throw new Error('HEROKU_READ_OWNER_OR_APP_FORBIDDEN');
  if(!env.NYX_HEROKU_BROKER_URL||!env.NYX_HEROKU_BROKER_SHARED_KEY)
    throw new Error('HEROKU_BROKER_NOT_CONFIGURED');
  return {ownerId,connectionId:id,app};
}
