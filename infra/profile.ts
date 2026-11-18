/**
 * The two deployment shapes `npm run demo:rollout` compares, and the four lines that are
 * the whole difference between them.
 *
 * Keeping the broken one in the program rather than in a branch of a demo script is the
 * point: a measurement that cannot fail is not a measurement, and the control run has to
 * come from the same code path as the real one or it is proving something else.
 */
export const DeployProfile = {
    /** maxUnavailable 0, both probes, a grace period longer than the drain. */
    Hardened: 'hardened',
    /** What you get by leaving the defaults alone: 25 % unavailable and no probes. */
    Broken: 'broken',
} as const;

export type DeployProfile = (typeof DeployProfile)[keyof typeof DeployProfile];

/** Named because the Deployment builder takes it and both demos print parts of it. */
export interface RolloutShape {
    profile: DeployProfile;
    /** The one number criterion 7 reads out of the cluster. Zero is the whole exercise. */
    maxUnavailable: number;
    maxSurge: number;
    /** Must exceed `drainMs`, or SIGKILL lands in the middle of the drain. */
    gracePeriodSeconds: number;
    /** Waited out before the socket opens — see src/main.ts. */
    warmupMs: number;
    /** Waited out after SIGTERM with readiness already red. */
    drainMs: number;
    probes: boolean;
}

const WARMUP_MS = 4_000;
const DRAIN_MS = 5_000;

const SHAPES: Readonly<Record<DeployProfile, RolloutShape>> = {
    [DeployProfile.Hardened]: {
        profile: DeployProfile.Hardened,
        maxUnavailable: 0,
        maxSurge: 1,
        // Four seconds of warm-up plus five of drain, and twenty to hold both with room:
        // a grace period smaller than the drain turns a correct shutdown into exit 137.
        gracePeriodSeconds: 20,
        warmupMs: WARMUP_MS,
        drainMs: DRAIN_MS,
        probes: true,
    },
    [DeployProfile.Broken]: {
        profile: DeployProfile.Broken,
        // 1 of 2 replicas is what the 25 % default rounds to here, and it is what lets
        // Kubernetes take the only serving pod away before the new one answers anything.
        maxUnavailable: 1,
        maxSurge: 1,
        gracePeriodSeconds: 30,
        // The same slow start, with nothing watching it. Without the warm-up the broken
        // profile measures a process that happens to be fast rather than a cluster that
        // was not told when to send traffic.
        warmupMs: WARMUP_MS,
        // No drain: the socket closes the instant SIGTERM lands, while the Service is
        // still handing this pod's address out. That is the second of the two holes.
        drainMs: 0,
        probes: false,
    },
};

const PROFILE_VARIABLE = 'MARKETPLACE_PROFILE';
const REV_VARIABLE = 'MARKETPLACE_REV';

export function readProfile(env: NodeJS.ProcessEnv): RolloutShape {
    const requested = env[PROFILE_VARIABLE] ?? DeployProfile.Hardened;

    if (!isProfile(requested)) {
        const known = Object.values(DeployProfile).join(' | ');
        throw new Error(`${PROFILE_VARIABLE}="${requested}" is not one of: ${known}`);
    }

    return SHAPES[requested];
}

/**
 * What makes Kubernetes notice that there is anything to roll out.
 *
 * A rolling update is triggered by a change to the **pod template**, and `:hw28` is a
 * mutable tag: rebuild the image under the same tag, apply the same manifest, and the
 * cluster correctly sees no difference and does nothing. This value rides in an
 * annotation so that a release is a change to the template even when the tag is not.
 */
export function readRevision(env: NodeJS.ProcessEnv): string {
    return env[REV_VARIABLE] ?? '1';
}

function isProfile(value: string): value is DeployProfile {
    return Object.values(DeployProfile).some((known) => known === value);
}
