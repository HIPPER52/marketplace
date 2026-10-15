/**
 * The runtime modes this service distinguishes.
 *
 * Declared here and consumed by the environment schema rather than the other way round:
 * `z.enum(NODE_ENVS)` means the validator and every `=== NodeEnv.Production` in the code
 * are the same list by construction. A literal `'production'` compared against a schema
 * that spelled it differently compiles perfectly and is wrong at exactly one moment.
 */
export const NodeEnv = {
    Development: 'development',
    Test: 'test',
    Production: 'production',
} as const;

export type NodeEnv = (typeof NodeEnv)[keyof typeof NodeEnv];

/** The same values as the tuple `z.enum` wants. */
export const NODE_ENVS = Object.values(NodeEnv) as [NodeEnv, ...NodeEnv[]];
