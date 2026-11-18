import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The same k8s/stack.json the Pulumi program reads — see infra/stack.ts for why it is a
 * file rather than Pulumi config.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const STACK = JSON.parse(readFileSync(join(ROOT, 'k8s', 'stack.json'), 'utf8'));

export const REPO_ROOT = ROOT;
export const IMAGE_REF = `${STACK.image}:${STACK.tag}`;
export const KUBE_CONTEXT = `kind-${STACK.cluster}`;
