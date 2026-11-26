import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The names and ports three different kinds of tool have to agree on.
 *
 * `npm run image:build` tags an image, `npm run cluster:up` creates a cluster with that
 * name and loads that image into it, this program deploys it, and the three demo scripts
 * address it. Spreading those strings across a shell script, a YAML file and a TypeScript
 * program is four copies of one fact, and the first rename proves it.
 *
 * Plain JSON rather than Pulumi config, because two of the four readers run before a
 * stack exists: `image:build` has no cluster and `cluster:up` has no Pulumi state.
 */
export interface Stack {
    /** kind's cluster name; the kubectl context is `kind-<cluster>`. */
    cluster: string;
    namespace: string;
    /** Repository without the tag — the two are separate so `kind load` can join them. */
    image: string;
    tag: string;
    /** Published by k8s/kind-config.yaml as the same hostPort; cluster:up checks that. */
    nodePort: number;
    containerPort: number;
}

const STACK_PATH = join(__dirname, '..', 'k8s', 'stack.json');

export function readStack(): Stack {
    const parsed: unknown = JSON.parse(readFileSync(STACK_PATH, 'utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`${STACK_PATH} does not hold an object`);
    }

    const stack = parsed as Partial<Stack>;

    for (const key of ['cluster', 'namespace', 'image', 'tag'] as const) {
        if (typeof stack[key] !== 'string' || stack[key].length === 0) {
            throw new Error(`${STACK_PATH}: "${key}" must be a non-empty string`);
        }
    }

    for (const key of ['nodePort', 'containerPort'] as const) {
        if (typeof stack[key] !== 'number' || !Number.isInteger(stack[key])) {
            throw new Error(`${STACK_PATH}: "${key}" must be an integer`);
        }
    }

    return stack as Stack;
}

/**
 * `repository:tag`, in one place so nothing builds it by hand — unless a pipeline has
 * already named the exact bytes, in which case those win.
 *
 * `IMAGE_REF` is how a promotion speaks. A tag is a mutable pointer: `marketplace:hw28`
 * means whatever was pushed under that name most recently, which is fine on a laptop
 * where the thing that built it is the thing that loads it, and useless the moment a
 * build job and a deploy job are two machines minutes apart. `ghcr.io/…@sha256:…` names
 * content, so the deploy cannot run bytes the gates did not pass — the digest in the
 * Deployment is the digest the build produced or the manifest is wrong.
 *
 * Unset — the local flow, every demo, the README — and nothing changes.
 */
export function imageRef(stack: Stack): string {
    const promoted = process.env.IMAGE_REF;

    if (promoted !== undefined && promoted.trim() !== '') {
        return promoted.trim();
    }

    return `${stack.image}:${stack.tag}`;
}

/** The kubectl context kind creates. Pinning it is what stops a deploy to the wrong cluster. */
export function contextOf(stack: Stack): string {
    return `kind-${stack.cluster}`;
}
