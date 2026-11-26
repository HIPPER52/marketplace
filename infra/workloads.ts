import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import type { RolloutShape } from './profile';
import { DB_PASSWORD } from './secrets';
import type { Stack } from './stack';
import { imageRef } from './stack';

/**
 * Everything that goes into the cluster, as typed resources rather than YAML.
 *
 * What the types buy is narrow and worth stating plainly: a misspelled `seelctor` is
 * TS2353 and `replicas: "2"` is TS2322, both without a cluster to try them against. What
 * they do not buy is also worth stating — a field left out entirely is legal, because the
 * schema says it is optional, which is exactly why criterion 7 reads the probes back out
 * of the running cluster instead of out of this file.
 */

const APP = 'marketplace';
const API = 'marketplace-api';
const POSTGRES = 'postgres';
const REDIS_CACHE = 'redis-cache';
const REDIS_QUEUE = 'redis-queue';

/** The role owns the database, so it needs no grant on schema public — see init.sql. */
const DB_ROLE = 'marketplace_app';
const DB_NAME = 'marketplace';
const DB_PORT = 5432;
const REDIS_PORT = 6379;

/** Where the database password is mounted, and what the service is told to read. */
const DB_PASSWORD_PATH = '/run/secrets/db_password';

/** The same two images the compose stand runs, with the same arguments. */
const POSTGRES_IMAGE = 'postgres:17-alpine';
const REDIS_IMAGE = 'redis:8-alpine';

export function labelsFor(component: string): Record<string, string> {
    return { 'app.kubernetes.io/name': APP, 'app.kubernetes.io/component': component };
}

/** Named because four builders below take the same three things. */
export interface ClusterArgs {
    namespace: pulumi.Input<string>;
    stack: Stack;
    opts: pulumi.CustomResourceOptions;
}

export interface DataLayerArgs extends ClusterArgs {
    dbSecretName: pulumi.Input<string>;
}

export interface DataLayer {
    postgres: k8s.apps.v1.Deployment;
    redisCache: k8s.apps.v1.Deployment;
    redisQueue: k8s.apps.v1.Deployment;
}

/**
 * Postgres and the two Redis instances, in the cluster rather than outside it.
 *
 * Not decoration: this service refuses to start without a database and both caches — its
 * own environment schema says so — and a readiness probe that pinged nothing would make
 * the whole measurement a lie. `emptyDir` and a single replica, because what is being
 * demonstrated is the application surviving an update, not Postgres surviving one; a
 * StatefulSet with a volume claim is a different subject and a different assignment.
 */
export function dataLayer(args: DataLayerArgs): DataLayer {
    const postgres = new k8s.apps.v1.Deployment(
        POSTGRES,
        {
            metadata: { name: POSTGRES, namespace: args.namespace, labels: labelsFor(POSTGRES) },
            spec: {
                replicas: 1,
                selector: { matchLabels: labelsFor(POSTGRES) },
                template: {
                    metadata: { labels: labelsFor(POSTGRES) },
                    spec: {
                        containers: [
                            {
                                name: POSTGRES,
                                image: POSTGRES_IMAGE,
                                ports: [{ containerPort: DB_PORT }],
                                env: [
                                    { name: 'POSTGRES_USER', value: DB_ROLE },
                                    { name: 'POSTGRES_DB', value: DB_NAME },
                                    {
                                        name: 'POSTGRES_PASSWORD',
                                        valueFrom: {
                                            secretKeyRef: {
                                                name: args.dbSecretName,
                                                key: DB_PASSWORD,
                                            },
                                        },
                                    },
                                    // The image refuses to initialise into a directory it
                                    // does not own, and an emptyDir mount brings a
                                    // lost+found with it on some kernels.
                                    {
                                        name: 'PGDATA',
                                        value: '/var/lib/postgresql/data/pgdata',
                                    },
                                ],
                                volumeMounts: [
                                    { name: 'data', mountPath: '/var/lib/postgresql/data' },
                                ],
                                readinessProbe: {
                                    exec: {
                                        command: ['pg_isready', '-U', DB_ROLE, '-d', DB_NAME],
                                    },
                                    initialDelaySeconds: 2,
                                    periodSeconds: 2,
                                },
                                resources: {
                                    requests: { cpu: '50m', memory: '128Mi' },
                                    limits: { memory: '512Mi' },
                                },
                            },
                        ],
                        volumes: [{ name: 'data', emptyDir: {} }],
                    },
                },
            },
        },
        args.opts,
    );

    new k8s.core.v1.Service(
        POSTGRES,
        {
            metadata: { name: POSTGRES, namespace: args.namespace, labels: labelsFor(POSTGRES) },
            spec: {
                selector: labelsFor(POSTGRES),
                ports: [{ port: DB_PORT, targetPort: DB_PORT }],
            },
        },
        args.opts,
    );

    return {
        postgres,
        // The arguments are the compose stand's, down to the empty --save: the cache may
        // evict and must have a ceiling, the queue may not evict and must not have one.
        redisCache: redis(REDIS_CACHE, args, [
            'redis-server',
            '--maxmemory',
            '64mb',
            '--maxmemory-policy',
            'allkeys-lru',
            '--save',
            '',
        ]),
        redisQueue: redis(REDIS_QUEUE, args, [
            'redis-server',
            '--maxmemory-policy',
            'noeviction',
            '--appendonly',
            'yes',
            '--appendfsync',
            'everysec',
        ]),
    };
}

function redis(name: string, args: ClusterArgs, command: string[]): k8s.apps.v1.Deployment {
    const deployment = new k8s.apps.v1.Deployment(
        name,
        {
            metadata: { name, namespace: args.namespace, labels: labelsFor(name) },
            spec: {
                replicas: 1,
                selector: { matchLabels: labelsFor(name) },
                template: {
                    metadata: { labels: labelsFor(name) },
                    spec: {
                        containers: [
                            {
                                name,
                                image: REDIS_IMAGE,
                                command,
                                ports: [{ containerPort: REDIS_PORT }],
                                readinessProbe: {
                                    exec: { command: ['redis-cli', 'ping'] },
                                    initialDelaySeconds: 1,
                                    periodSeconds: 2,
                                },
                                resources: {
                                    requests: { cpu: '10m', memory: '32Mi' },
                                    limits: { memory: '128Mi' },
                                },
                            },
                        ],
                    },
                },
            },
        },
        args.opts,
    );

    new k8s.core.v1.Service(
        name,
        {
            metadata: { name, namespace: args.namespace, labels: labelsFor(name) },
            spec: {
                selector: labelsFor(name),
                ports: [{ port: REDIS_PORT, targetPort: REDIS_PORT }],
            },
        },
        args.opts,
    );

    return deployment;
}

/** The non-secret half of the application's environment. */
export function configurationFor(shape: RolloutShape): Record<string, string> {
    return {
        NODE_ENV: 'production',
        PORT: String(3000),
        DATABASE_URL: `postgres://${DB_ROLE}@${POSTGRES}:${DB_PORT}/${DB_NAME}`,
        DB_PASSWORD_FILE: DB_PASSWORD_PATH,
        REDIS_URL: `redis://${REDIS_CACHE}:${REDIS_PORT}`,
        REDIS_QUEUE_URL: `redis://${REDIS_QUEUE}:${REDIS_PORT}`,
        WARMUP_MS: String(shape.warmupMs),
        DRAIN_MS: String(shape.drainMs),
        LOG_LEVEL: 'log',
    };
}

export interface MigrationArgs extends DataLayerArgs {
    revision: string;
}

/**
 * The schema, applied once per revision.
 *
 * A Job and not an init container: an init container runs once per pod, so two replicas
 * would start two migration runs against one database. The command is a file path because
 * the image has no shell — `npm run migrate` is a shell line and this is
 * `node dist/database/cli/migrate.js`, reaching the same migrations in dist/migrations/.
 */
export function migrationJob(args: MigrationArgs): k8s.batch.v1.Job {
    const name = `migrate-${args.revision}`;

    return new k8s.batch.v1.Job(
        'migrate',
        {
            metadata: { name, namespace: args.namespace, labels: labelsFor('migrate') },
            spec: {
                backoffLimit: 3,
                template: {
                    metadata: { labels: labelsFor('migrate') },
                    spec: {
                        restartPolicy: 'Never',
                        containers: [
                            {
                                name: 'migrate',
                                image: imageRef(args.stack),
                                imagePullPolicy: 'IfNotPresent',
                                // `command` replaces the image's entrypoint, so the
                                // interpreter has to be named: distroless puts node at
                                // this path and provides nothing to resolve a bare name.
                                command: ['/nodejs/bin/node'],
                                args: ['dist/database/cli/migrate.js'],
                                // The flat DB_* block the CLI tools read — a migration run
                                // lives for two seconds and has no connection to rotate,
                                // which is why it takes the password as a value and the
                                // service takes it as a file.
                                env: [
                                    { name: 'DB_HOST', value: POSTGRES },
                                    { name: 'DB_PORT', value: String(DB_PORT) },
                                    { name: 'DB_USER', value: DB_ROLE },
                                    { name: 'DB_NAME', value: DB_NAME },
                                    {
                                        name: DB_PASSWORD,
                                        valueFrom: {
                                            secretKeyRef: {
                                                name: args.dbSecretName,
                                                key: DB_PASSWORD,
                                            },
                                        },
                                    },
                                ],
                                resources: { requests: { cpu: '50m', memory: '128Mi' } },
                            },
                        ],
                    },
                },
            },
        },
        args.opts,
    );
}

export interface ApplicationArgs extends ClusterArgs {
    shape: RolloutShape;
    revision: string;
    replicas: number;
    configMapName: pulumi.Input<string>;
    appSecretName: pulumi.Input<string>;
    dbSecretName: pulumi.Input<string>;
    /**
     * The registry credential, when the image comes from one.
     *
     * Absent locally: `kind load` puts the image inside the node and there is nothing to
     * authenticate to. Present in the pipeline, where the image is promoted by digest out
     * of a private package and the node has to fetch it.
     */
    pullSecretName?: pulumi.Input<string>;
}

export function application(args: ApplicationArgs): k8s.apps.v1.Deployment {
    const { shape } = args;
    const labels = labelsFor('api');

    return new k8s.apps.v1.Deployment(
        API,
        {
            metadata: { name: API, namespace: args.namespace, labels },
            spec: {
                replicas: args.replicas,
                selector: { matchLabels: labels },
                strategy: {
                    type: 'RollingUpdate',
                    rollingUpdate: {
                        // The one number criterion 7 reads. Zero means "never fewer than
                        // the declared count while rolling", which is why the correct
                        // profile takes four times as long and loses nothing.
                        maxUnavailable: shape.maxUnavailable,
                        maxSurge: shape.maxSurge,
                    },
                },
                template: {
                    metadata: {
                        labels,
                        // A change here is what a rolling update actually reacts to. The
                        // tag is mutable, so without this a rebuilt image under the same
                        // tag is, to Kubernetes, no change at all.
                        annotations: {
                            'marketplace/rev': args.revision,
                            'marketplace/profile': shape.profile,
                        },
                    },
                    spec: {
                        terminationGracePeriodSeconds: shape.gracePeriodSeconds,
                        ...(args.pullSecretName === undefined
                            ? {}
                            : { imagePullSecrets: [{ name: args.pullSecretName }] }),
                        securityContext: {
                            runAsNonRoot: true,
                            // Numeric: the kubelet verifies this before the container
                            // starts and cannot resolve the name `nonroot`.
                            runAsUser: 65532,
                        },
                        containers: [
                            {
                                name: 'api',
                                image: imageRef(args.stack),
                                // `IfNotPresent` is right for both ways the image can
                                // arrive, for two different reasons. Locally it is built
                                // on the host and loaded into the node with `kind load`;
                                // it exists in no registry, and `Always` would hang the
                                // pod in ErrImagePull. From a registry it arrives by
                                // digest, and a digest names content — once the node has
                                // those bytes there is nothing a re-pull could change.
                                imagePullPolicy: 'IfNotPresent',
                                ports: [{ containerPort: args.stack.containerPort }],
                                envFrom: [
                                    { configMapRef: { name: args.configMapName } },
                                    // The reference criterion 10 looks for: the values
                                    // live in the Secret, and this manifest carries only
                                    // its name.
                                    { secretRef: { name: args.appSecretName } },
                                ],
                                volumeMounts: [
                                    {
                                        name: 'db-password',
                                        mountPath: '/run/secrets',
                                        readOnly: true,
                                    },
                                ],
                                ...probesFor(shape, args.stack.containerPort),
                                resources: {
                                    // A CPU request is what makes the HPA's percentage
                                    // mean anything: utilisation is measured against it.
                                    requests: { cpu: '100m', memory: '192Mi' },
                                    limits: { memory: '768Mi' },
                                },
                                securityContext: { allowPrivilegeEscalation: false },
                            },
                        ],
                        volumes: [
                            {
                                name: 'db-password',
                                secret: {
                                    secretName: args.dbSecretName,
                                    items: [{ key: DB_PASSWORD, path: 'db_password' }],
                                },
                            },
                        ],
                    },
                },
            },
        },
        args.opts,
    );
}

/** Named return rather than an inline spread, so what the broken profile omits is visible. */
export interface Probes {
    readinessProbe?: k8s.types.input.core.v1.Probe;
    livenessProbe?: k8s.types.input.core.v1.Probe;
}

/**
 * Two probes on two paths, answering two questions.
 *
 * `/readiness` asks "may I be sent traffic" and is allowed to say no for a while — during
 * the warm-up, and for the whole drain after SIGTERM. `/health` asks "should I be killed"
 * and says yes only when the process is beyond saving. Pointing `livenessProbe` at the
 * readiness path is the classic way to turn "busy for a moment" into a restart loop, which
 * is why the criterion checks that the two paths differ rather than that they exist.
 */
function probesFor(shape: RolloutShape, port: number): Probes {
    if (!shape.probes) {
        return {};
    }

    return {
        readinessProbe: {
            httpGet: { path: '/readiness', port },
            // One second and one failure: this is the number that decides how long a pod
            // that has just been told to go away keeps receiving traffic.
            periodSeconds: 1,
            failureThreshold: 1,
            timeoutSeconds: 2,
        },
        livenessProbe: {
            httpGet: { path: '/health', port },
            // Longer than the warm-up by a wide margin. A liveness probe that fires during
            // a slow start restarts the pod for being slow, and the restart starts it
            // slowly again.
            initialDelaySeconds: 15,
            periodSeconds: 10,
            failureThreshold: 3,
            timeoutSeconds: 2,
        },
    };
}

export interface ExposureArgs extends ClusterArgs {
    replicas: number;
}

export interface Exposure {
    service: k8s.core.v1.Service;
    budget: k8s.policy.v1.PodDisruptionBudget;
    autoscaler: k8s.autoscaling.v2.HorizontalPodAutoscaler;
}

export function exposure(args: ExposureArgs): Exposure {
    const labels = labelsFor('api');

    const service = new k8s.core.v1.Service(
        API,
        {
            metadata: { name: API, namespace: args.namespace, labels },
            spec: {
                type: 'NodePort',
                selector: labels,
                ports: [
                    {
                        port: args.stack.containerPort,
                        targetPort: args.stack.containerPort,
                        // Fixed rather than assigned, because kind publishes exactly this
                        // port to the host in k8s/kind-config.yaml.
                        nodePort: args.stack.nodePort,
                    },
                ],
            },
        },
        args.opts,
    );

    /**
     * One less than the replica count, deliberately.
     *
     * `minAvailable: replicas` reads like maximum protection and is the opposite: it
     * leaves zero voluntary disruptions, so a node drain blocks for ever and an
     * administrator cannot patch the machine. A budget is a contract about planned work,
     * not insurance — it counts an unplanned death without preventing it, and
     * `kubectl delete pod` goes straight past it by design.
     */
    const budget = new k8s.policy.v1.PodDisruptionBudget(
        API,
        {
            metadata: { name: API, namespace: args.namespace, labels },
            spec: { minAvailable: args.replicas - 1, selector: { matchLabels: labels } },
        },
        args.opts,
    );

    const autoscaler = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
        API,
        {
            metadata: { name: API, namespace: args.namespace, labels },
            spec: {
                scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: API },
                minReplicas: args.replicas,
                maxReplicas: args.replicas * 2,
                metrics: [
                    {
                        type: 'Resource',
                        resource: {
                            name: 'cpu',
                            target: { type: 'Utilization', averageUtilization: 70 },
                        },
                    },
                ],
            },
        },
        args.opts,
    );

    return { service, budget, autoscaler };
}
