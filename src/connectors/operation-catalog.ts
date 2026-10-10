/** Inventory for a future NestNyx connections panel; NOT an execution router. */
export const CONNECTOR_OPERATION_CATALOG = {
  // Existing operator-scoped Rclone service, not yet per-user connector execution.
  'storage.areas':      { capability:'storage:list',    backend:'legacy' },
  'storage.list':       { capability:'storage:list',    backend:'legacy' },
  'storage.stat':       { capability:'storage:stat',    backend:'legacy' },
  'storage.capacity':   { capability:'storage:capacity',backend:'legacy' },
  'storage.copy':       { capability:'storage:copy',    backend:'legacy' },
  'storage.globalIndex':{ capability:'storage:index',   backend:'legacy' },
  'mega.accounts':      { capability:'storage:list',    backend:'legacy' },
  'mega.list':          { capability:'storage:list',    backend:'legacy' },
  'mega.stat':          { capability:'storage:stat',    backend:'legacy' },
  'mega.capacity':      { capability:'storage:capacity',backend:'legacy' },
  // Existing Head-resolved NYX runtime: governed by canonical CLI, not a provider toggle.
  'nyx.execute':        { capability:null, backend:'canonical' },
  'nyx.ini':            { capability:null, backend:'canonical' },
  'nyx.sum':            { capability:null, backend:'canonical' },
  'nyx.key':            { capability:null, backend:'disabled' },
  // Existing provider adapter is a library prototype, not exposed over live MCP yet.
  'github.workflows':   { capability:'ci:read', backend:'prototype' },
  'github.runs':        { capability:'ci:read', backend:'prototype' },
  'github.jobs':        { capability:'ci:read', backend:'prototype' },
  // Git CLI operations: planning contract only; isolated worker is not implemented.
  'git.status':         { capability:'git:inspect', backend:'planned' },
  'git.log':            { capability:'git:inspect', backend:'planned' },
  'git.show':           { capability:'git:inspect', backend:'planned' },
  'git.clone':          { capability:'git:clone', backend:'planned' },
  'git.fetch':          { capability:'git:fetch', backend:'planned' },
  'git.diff':           { capability:'git:diff', backend:'planned' },
  'git.branch.create':  { capability:'git:branch', backend:'planned' },
  'git.commit':         { capability:'git:commit', backend:'planned' },
  'git.push':           { capability:'git:push', backend:'planned' },
  'git.tag.create':     { capability:'git:tag', backend:'planned' },
  'git.pr.read':        { capability:'pulls:read', backend:'planned' },
  'git.pr.create':      { capability:'pulls:write', backend:'planned' },
  'git.issue.read':     { capability:'issues:read', backend:'planned' },
  'git.issue.write':    { capability:'issues:write', backend:'planned' },
  'git.release.read':   { capability:'releases:read', backend:'planned' },
  'git.release.write':  { capability:'releases:write', backend:'planned' },
  'git.ci.dispatch':    { capability:'ci:dispatch', backend:'planned' },
} as const;

export type ConnectorOperation = keyof typeof CONNECTOR_OPERATION_CATALOG;
export type ConnectorOperationBackend = typeof CONNECTOR_OPERATION_CATALOG[ConnectorOperation]['backend'];
