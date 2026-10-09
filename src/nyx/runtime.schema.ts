import * as z from 'zod/v4';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const argumentToken = z.string().min(1).max(64).refine(value => /^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|\+\+|--)$/.test(value), 'invalid command argument');
export const depthSchema = z.enum(['basic', 'normal', 'deep']);
export const scopeSchema = z.enum(['local', 'global']);
export const refSchema = z.object({
  area: name, path: z.string().min(1).max(2048), driveId: z.string().optional(),
}).strict();
export const locatorSchema = z.object({
  schema: z.literal('nyx.bootstrap.v1'),
  cli: refSchema.extend({ member: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  humanCli: refSchema.optional(),
  executionProfile: refSchema.optional(),
  paths: z.object({ basic: refSchema, normal: refSchema.optional(), deep: refSchema.optional() }).strict(),
  canonical: z.object({ head: z.string().min(1), body: z.string().min(1), footer: z.string().min(1) }).strict(),
}).strict();
export const sourceSchema = z.object({
  key: z.string().min(1).max(128), required: z.boolean(), visible: z.boolean(),
  when: z.enum(['always', 'targeted']).default('always'), perTarget: z.boolean().default(false),
}).strict();
export const scopeConfigSchema = z.object({
  default: scopeSchema,
  localAreas: z.array(name).min(1),
  externalContext: z.array(z.string().min(1).max(128)).default([]),
  globalLabel: z.string().min(1).max(128).default('all_configured_nyx_drives'),
}).strict();
export const executionSchema = z.object({
  adapter: z.enum(['context.initialize.v1', 'context.read.v1', 'context.summarize.v1']),
  depth: z.object({ default: depthSchema, allowed: z.array(depthSchema).min(1) }).strict(),
  scope: scopeConfigSchema.optional(),
  arguments: z.object({ targets: z.boolean(), maxTargets: z.number().int().min(0).max(16) }).strict(),
  sources: z.object({ basic: z.array(sourceSchema), normal: z.array(sourceSchema), deep: z.array(sourceSchema) }).strict(),
  pathsVisible: z.boolean(),
  mutation: z.enum(['none', 'conversation-artifact']),
  handoffsKey: z.string().min(1).optional(),
  verification: z.object({ sourceRead: z.literal(true), artifactReadback: z.boolean() }).strict(),
  response: z.literal('nyx.context.v1'),
}).strict();
// Historical descriptive commands can be discovered, but not executed without a typed contract.
export const cliSchema = z.object({
  schema: z.string().min(1), version: z.string().min(1),
  commands: z.record(name, z.object({ aliases: z.array(name).optional(), execution: executionSchema.optional() }).passthrough()),
}).passthrough();
export const profileSchema = z.object({
  schema: z.literal('nyx.runtime-profile.v1'),
  authority: z.literal('user-authorized-runtime-configuration'),
  cliSha256: z.string().regex(/^[a-f0-9]{64}$/),
  commands: z.record(name, executionSchema),
}).strict();
export const requestSchema = z.object({
  command: name,
  args: z.array(argumentToken).max(16).default([]),
  depth: depthSchema.optional(),
  scope: scopeSchema.optional(),
  conversationId: z.string().min(1).max(256).optional(),
}).strict();
export const routingSchema = z.object({ schema: z.literal('nyx.paths.v1'), resources: z.record(z.string(), refSchema) }).strict();
export type ResourceRef = z.infer<typeof refSchema>;
export type Locator = z.infer<typeof locatorSchema>;
export type Cli = z.infer<typeof cliSchema>;
export type Contract = z.infer<typeof executionSchema>;
export type CommandRequest = z.input<typeof requestSchema>;
export type LoadedSource = { key: string; ref: ResourceRef; sha256: string; bytes: number; content: string; visible: boolean };
export function parseJson(text: string): unknown { return JSON.parse(text.replace(/^\uFEFF/, '')); }
