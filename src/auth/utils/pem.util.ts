/**
 * A PEM key, carried through an environment variable.
 *
 * **base64 around the PEM, not the PEM itself.** A PEM is multi-line, and a multi-line
 * value does not survive every way an environment variable gets set — a Kubernetes
 * manifest, a CI secret pasted into a web form, `export X="$(cat …)"` in a shell that
 * mangles newlines. The reward for finding out the hard way is
 * `error:1E08010C:DECODER routines::unsupported` on the first signature, which says
 * nothing about newlines. One base64 hop removes the whole class.
 */
export function decodePem(encoded: string): string {
    return Buffer.from(encoded, 'base64').toString('utf8');
}

/** What is wrong with an encoded key, or null when nothing is. */
export function pemProblem(encoded: string, kind: 'PRIVATE' | 'PUBLIC'): string | null {
    let pem: string;

    try {
        pem = decodePem(encoded);
    } catch {
        return 'must be base64';
    }

    if (!pem.includes(`BEGIN ${kind} KEY`)) {
        return (
            `must be base64 of a PEM containing "BEGIN ${kind} KEY" — ` +
            `e.g. export JWT_${kind}_KEY="$(cat key.pem | base64)"`
        );
    }

    return null;
}
