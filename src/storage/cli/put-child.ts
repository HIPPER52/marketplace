import { demoPayload } from '../constants/demo.constant';

/**
 * Puts the bytes in the store, from a process that knows nothing.
 *
 * Its environment has `PATH` and the IPC channel `fork` needs, and that is all: **no
 * access key, no secret, no endpoint**. Everything it can do is in the URL it was handed,
 * which is the claim a presigned URL makes and the one `put-offline=200` measures — the
 * bytes arrive while the service that authorised them is switched off.
 */
interface Plan {
    url: string;
    contentType: string;
    sizeBytes: number;
}

async function main(): Promise<void> {
    const plan = JSON.parse(process.argv[2] ?? '{}') as Plan;
    const body = demoPayload(plan.sizeBytes);

    const response = await fetch(plan.url, {
        method: 'PUT',
        // The grant is signed with this content type, so sending another one is a
        // different canonical request and the store answers 403. That narrowing is
        // deliberate; see Presigner.
        headers: { 'content-type': plan.contentType, 'content-length': String(body.length) },
        body: new Uint8Array(body),
    });

    process.send?.({ status: response.status });
}

main().catch((error: unknown) => {
    process.send?.({ status: 0, error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
