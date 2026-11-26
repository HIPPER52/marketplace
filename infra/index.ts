import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { readProfile, readRevision } from './profile';
import { applicationSecrets, DB_PASSWORD, encode, readSecrets } from './secrets';
import { contextOf, imageRef, readStack } from './stack';
import {
    application,
    configurationFor,
    dataLayer,
    exposure,
    labelsFor,
    migrationJob,
} from './workloads';

/**
 * The first statement of the program, and the order is the requirement.
 *
 * Validate the environment before anything reaches for the cluster. The other way round,
 * a missing password surfaces as a connection error or a timeout somewhere in the middle
 * of a preview, and whoever ran it learns that something is wrong rather than which value
 * is absent. `pulumi preview` with any one of them removed exits non-zero and prints the
 * name — that is a criterion, and it is also just how a deployment tool should behave.
 */
const secrets = readSecrets(process.env);
const shape = readProfile(process.env);
const revision = readRevision(process.env);
const stack = readStack();

const config = new pulumi.Config();
const replicas = config.getNumber('replicas') ?? 2;

if (replicas < 2) {
    throw new Error(
        `replicas is ${replicas}: a PodDisruptionBudget over a single replica is self-deception. ` +
            'minAvailable would have to be 0 to allow any voluntary disruption at all, ' +
            'and a budget that allows everything protects nothing. Two is the smallest honest number.',
    );
}

/**
 * Pinned to the cluster `npm run cluster:up` creates, rather than to whatever `kubectl`
 * happens to be pointing at. A deploy that silently followed the current context is one
 * forgotten `kubectl config use-context` away from being a deploy into production.
 */
const provider = new k8s.Provider('cluster', { context: contextOf(stack) });
const opts: pulumi.CustomResourceOptions = { provider };

const namespace = new k8s.core.v1.Namespace(
    'marketplace',
    { metadata: { name: stack.namespace, labels: labelsFor('namespace') } },
    opts,
);

const namespaceName = namespace.metadata.name;

/**
 * Two Secrets and not one, because they have two audiences.
 *
 * The database password is read by Postgres itself and by the migration Job, and reaches
 * the application as a **file** — the #13 decision, which lets ./rotate.sh replace it
 * under a running process. Everything else is read by the application as variables. One
 * Secret carrying both would put the password into the environment of every API pod for
 * no reason at all.
 */
const dbSecret = new k8s.core.v1.Secret(
    'db-password',
    {
        metadata: { name: 'marketplace-db', namespace: namespaceName, labels: labelsFor('db') },
        data: { [DB_PASSWORD]: encode(secrets[DB_PASSWORD]) },
    },
    opts,
);

const appSecret = new k8s.core.v1.Secret(
    'app-secrets',
    {
        metadata: { name: 'marketplace-app', namespace: namespaceName, labels: labelsFor('api') },
        data: applicationSecrets(secrets),
    },
    opts,
);

const configMap = new k8s.core.v1.ConfigMap(
    'app-config',
    {
        metadata: {
            name: 'marketplace-config',
            namespace: namespaceName,
            labels: labelsFor('api'),
        },
        data: configurationFor(shape),
    },
    opts,
);

const layer = dataLayer({
    namespace: namespaceName,
    stack,
    opts,
    dbSecretName: dbSecret.metadata.name,
});

const migrate = migrationJob({
    namespace: namespaceName,
    stack,
    // The schema before the pods that read it, and after the database that holds it.
    opts: { ...opts, dependsOn: [layer.postgres] },
    dbSecretName: dbSecret.metadata.name,
    revision,
});

/**
 * The credential the node pulls the image with, and only when there is an image to pull.
 *
 * `IMAGE_PULL_SECRET` carries a whole `.dockerconfigjson`, which is what the registry
 * protocol wants and what `kubernetes.io/dockerconfigjson` holds. It is produced by the
 * pipeline from the token GitHub already gave that job and lives as long as the cluster
 * does, which in a pipeline is one run.
 *
 * Unset — a laptop, where `kind load` puts the image inside the node — and no Secret is
 * created and no pod references one. The alternative, a Secret with an empty value that
 * is always there, would be a credential-shaped object that authenticates nothing: the
 * kubelet would try it, fail, and report `ImagePullBackOff` for a cluster that never
 * needed to pull anything.
 */
const registryCredential = (process.env.IMAGE_PULL_SECRET ?? '').trim();

const pullSecret =
    registryCredential === ''
        ? undefined
        : new k8s.core.v1.Secret(
              'registry',
              {
                  metadata: { name: 'registry', namespace: namespaceName },
                  type: 'kubernetes.io/dockerconfigjson',
                  // `data`, never `stringData`: the API server never returns the latter,
                  // so the provider sees a difference on every update and `pulumi up`
                  // twice in a row never says "unchanged". Same rule as the other two.
                  data: { '.dockerconfigjson': encode(registryCredential) },
              },
              opts,
          );

const api = application({
    namespace: namespaceName,
    stack,
    opts: { ...opts, dependsOn: [migrate, layer.redisCache, layer.redisQueue] },
    shape,
    revision,
    replicas,
    configMapName: configMap.metadata.name,
    appSecretName: appSecret.metadata.name,
    dbSecretName: dbSecret.metadata.name,
    pullSecretName: pullSecret?.metadata.name,
});

const surface = exposure({ namespace: namespaceName, stack, opts, replicas });

export const clusterNamespace = namespaceName;
export const deployment = api.metadata.name;
export const service = surface.service.metadata.name;
export const disruptionBudget = surface.budget.metadata.name;
export const autoscaler = surface.autoscaler.metadata.name;
export const nodePort = stack.nodePort;
export const profile = shape.profile;
export const rev = revision;

/**
 * Declared here and also written by a HorizontalPodAutoscaler, which in a cluster with a
 * metrics-server is a field two writers own.
 *
 * It is left declared on purpose. In kind there is no metrics-server, so the autoscaler
 * reports `cpu: <unknown>/70%` and scales nothing — remove `replicas` here and the
 * Deployment would default to one, which breaks the PodDisruptionBudget and the whole
 * point of the rollout measurement. The real answer for a cluster that does have metrics
 * is in the README: stop declaring it, or hand the field over with `ignoreChanges`.
 */
export const declaredReplicas = replicas;

/**
 * What was actually deployed, as the manifest names it.
 *
 * This is the half of "build once, promote by digest" that can be checked after the
 * fact: the pipeline compares it against the digest its build job pushed, and a
 * mismatch means something was rebuilt between the gates and the cluster.
 */
export const image = imageRef(stack);
