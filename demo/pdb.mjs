import { spawn } from 'node:child_process';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { delay, must } from '../scripts/lib/shell.mjs';
import { KUBE_CONTEXT, STACK } from '../scripts/lib/stack.mjs';

/**
 * What a PodDisruptionBudget stops, and what it does not.
 *
 *   npm run demo:pdb
 *
 * Two evictions through the Eviction API: the first is allowed and the second is refused,
 * because `minAvailable: 1` over two replicas leaves exactly one disruption to spend. The
 * numbers printed are the HTTP status codes the API server actually answered with — hence
 * a proxy rather than `kubectl create --raw`, which reports success or an error message
 * and never a code.
 *
 * The third fact is the one people are surprised by: `kubectl delete pod` walks straight
 * past the budget. That is not a gap, it is the definition — the documentation says in so
 * many words that deleting pods bypasses a disruption budget. A budget is a contract with
 * whoever is draining a node, not insurance against a pod dying.
 *
 * It is therefore also useless at `minAvailable: replicas`: zero disruptions allowed means
 * no node can ever be drained, and an administrator who cannot patch a machine is a
 * bigger risk than the one this was meant to manage.
 */

const EVICTION_ALLOWED = 201;
const EVICTION_REFUSED = 429;
const PROXY_READY = /Starting to serve on\s+(\S+)/;
const deployment = 'marketplace-api';

function kubectl(args) {
    return must('kubectl', ['--context', KUBE_CONTEXT, '-n', STACK.namespace, ...args]);
}

function readyPods() {
    const names = kubectl([
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/name=marketplace,app.kubernetes.io/component=api',
        '--field-selector=status.phase=Running',
        '-o',
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);

    return names.split('\n').filter((name) => name.length > 0);
}

/**
 * `kubectl proxy` on a port the kernel picks, so two of these can run side by side and
 * neither has to guess whether 8001 is free.
 */
function startProxy() {
    const child = spawn('kubectl', ['--context', KUBE_CONTEXT, 'proxy', '--port=0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('kubectl proxy did not start')), 15_000);

        child.stdout.on('data', (chunk) => {
            const match = PROXY_READY.exec(String(chunk));

            if (match?.[1]) {
                clearTimeout(timer);
                resolve({ address: `http://${match[1]}`, stop: () => child.kill('SIGTERM') });
            }
        });

        child.on('error', reject);
    });
}

async function evict(address, pod) {
    const response = await fetch(
        `${address}/api/v1/namespaces/${STACK.namespace}/pods/${pod}/eviction`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apiVersion: 'policy/v1',
                kind: 'Eviction',
                metadata: { name: pod, namespace: STACK.namespace },
            }),
        },
    );

    // Read the body so the connection is finished before the next request goes out.
    await response.text();
    return response.status;
}

async function main() {
    const budget = JSON.parse(kubectl(['get', 'pdb', deployment, '-o', 'json']));
    const pods = readyPods();

    emit('healthy', budget.status?.currentHealthy ?? 0);
    emit('minAvailable', budget.spec?.minAvailable ?? '—');

    if (pods.length < 2) {
        throw new Error(`expected two running pods, found ${pods.length}`);
    }

    if ((budget.status?.disruptionsAllowed ?? 0) < 1) {
        throw new Error(
            'disruptionsAllowed is 0 before the demo has spent anything. Either the ' +
                'previous run has not finished recovering, or minAvailable equals the ' +
                'replica count — which blocks every drain there will ever be.',
        );
    }

    const proxy = await startProxy();

    try {
        // Back to back on purpose: the budget is spent by the first and has not had time
        // to recover, which is exactly the situation a node drain creates.
        const first = await evict(proxy.address, pods[0]);
        const second = await evict(proxy.address, pods[1]);

        emit('evict-1', first);
        emit('evict-2', second);

        // The same pod the budget just refused to evict, deleted outright.
        kubectl(['delete', 'pod', pods[1], '--wait=false']);
        emit('delete-bypassed-budget', 1);

        if (first !== EVICTION_ALLOWED) {
            fail(`the first eviction answered ${first}, not ${EVICTION_ALLOWED}.`);
        }

        if (second !== EVICTION_REFUSED) {
            fail(
                `the second eviction answered ${second}, not ${EVICTION_REFUSED}: the budget ` +
                    'let two disruptions through, so it is not holding one replica back.',
            );
        }
    } finally {
        proxy.stop();
        // Leave the cluster as it was found: the next demo, and criterion 7, read it.
        await delay(1_000);
        kubectl(['rollout', 'status', `deploy/${deployment}`, '--timeout=5m']);
    }
}

main().catch((error) => {
    console.error(`\ndemo:pdb failed: ${error.message}\n`);
    process.exitCode = 2;
});
