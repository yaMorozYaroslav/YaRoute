import { ConnectorRegistry, type ConnectorCapability } from './connector-registry';

/** Heroku administration requires app-scoped authorization and an approval receipt. */
export const HEROKU_OPERATIONS = {
 'app.info':'heroku:apps:read',
 'app.releases':'heroku:releases:read',
 'app.logs':'heroku:logs:read',
 'config.names':'heroku:config:names',
 'config.set':'heroku:config:write',
 'app.deploy':'heroku:deploy',
 'app.restart':'heroku:apps:restart',
 'app.create':'heroku:apps:create',
} as const satisfies Record<string, ConnectorCapability>;

export type HerokuOperation = keyof typeof HEROKU_OPERATIONS;
export class HerokuOperationPlanner {
 constructor(private readonly registry: ConnectorRegistry) {}
 async plan(ownerId:string, connectionId:string, operation:HerokuOperation, resourceId:string) {
  if (!Object.prototype.hasOwnProperty.call(HEROKU_OPERATIONS,operation)) throw new Error('HEROKU_OPERATION_UNSUPPORTED');
  const accountOperation = operation === 'app.create';
  const kind = accountOperation ? 'heroku-account' as const : 'heroku-app' as const;
  const capability = HEROKU_OPERATIONS[operation];
  await this.registry.requireResource(ownerId,connectionId,capability,{kind,id:resourceId});
  return {operation,connectionId,resourceId,capability,approvalRequired:
   ['config.set','app.deploy','app.restart','app.create'].includes(operation),
   executor:'heroku-platform-api',executable:false};
 }
}
