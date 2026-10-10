/** Typed Git capability map. Execution is NOT enabled by this definition. */
export const GIT_OPERATIONS = {
  status: 'git:inspect', log: 'git:inspect', show: 'git:inspect',
  clone: 'git:clone', fetch: 'git:fetch', diff: 'git:diff',
  'branch.create': 'git:branch', commit: 'git:commit',
  push: 'git:push', 'tag.create': 'git:tag',
} as const;
export type GitOperation = keyof typeof GIT_OPERATIONS;
