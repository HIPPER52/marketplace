import { demoPayload } from '../constants/demo.constant';
import { putSignedPart, sliceFor } from '../utils/multipart.util';

/**
 * The uploader that dies in the middle.
 *
 * A **separate process**, killed with SIGKILL after a given number of parts — no
 * `finally`, no `AbortMultipartUpload`, no chance to tidy up, which is what a machine
 * losing power looks like and what a `try/catch` in one process never does.
 *
 * It holds **no credentials**: the parent spawns it with a scrubbed environment and hands
 * it presigned URLs. That is the same claim `demo:upload` makes about bytes going past
 * the service, made again about the parts.
 */
interface Plan {
    parts: { partNumber: number; url: string }[];
    partSize: number;
    totalBytes: number;
    stopAfter: number;
}

async function main(): Promise<void> {
    const plan = JSON.parse(process.argv[2] ?? '{}') as Plan;
    const body = demoPayload(plan.totalBytes);

    let done = 0;

    for (const part of plan.parts) {
        await putSignedPart(
            part.url,
            sliceFor(body, part.partNumber, plan.partSize),
            part.partNumber,
        );
        done += 1;
        console.log(`[child] part ${part.partNumber} of ${plan.parts.length} uploaded`);

        if (done >= plan.stopAfter) {
            console.log(`[child] dying after ${done} parts, without aborting anything`);
            process.kill(process.pid, 'SIGKILL');

            // Unreachable; SIGKILL cannot be handled, blocked or ignored.
            await new Promise(() => undefined);
        }
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
