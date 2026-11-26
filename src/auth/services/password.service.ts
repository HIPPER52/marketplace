import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id, with the library's defaults.
 *
 * Memory-hard on purpose: the attacker's advantage over a defender is parallel hardware,
 * and an algorithm whose cost is memory rather than cycles is the one that does not scale
 * on a GPU. `@node-rs/argon2` ships OWASP's parameter set (m=19456, t=2, p=1) and its own
 * prebuilt binaries, so `npm ci` needs no compiler on a machine this was never run on.
 *
 * The thing worth knowing about the cost is where it lands: tens of milliseconds and
 * ~19 MiB **per login**. A burst of logins hits a pod's memory limit long before it hits
 * its CPU limit, and that asymmetry — login expensive, every later request cheap — is the
 * entire reason tokens exist.
 *
 * Verification is constant-time and reads the parameters out of the stored hash, so
 * raising them later re-hashes nobody and breaks nothing.
 */
@Injectable()
export class PasswordService {
    hash(plain: string): Promise<string> {
        return hash(plain);
    }

    /**
     * False rather than a thrown error for a wrong password: a malformed or absent hash is
     * the same answer to the caller — "not this person" — and the login path must not be
     * able to tell the two apart by how it failed.
     */
    async matches(plain: string, stored: string | null): Promise<boolean> {
        if (stored === null) {
            return false;
        }

        try {
            return await verify(stored, plain);
        } catch {
            return false;
        }
    }
}
