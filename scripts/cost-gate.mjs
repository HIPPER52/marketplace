import { readFileSync } from 'node:fs';
import { emit } from './lib/emit.mjs';

/**
 * What this stack would cost for a month, compared against a budget, with an exit code.
 *
 *   PLAN_JSON=plan.json COST_BUDGET_USD=40 npm run gate:cost
 *
 * ## Why a gate and not a dashboard
 *
 * Infrastructure gets expensive one reviewed pull request at a time. Nobody ever merges
 * "make this cost $900 a month"; they merge a replica count, a volume size, a second
 * environment, and the bill is noticed six weeks later by somebody who was not in any of
 * those reviews. A cost estimate attached to the diff moves that conversation to the
 * moment it is cheap to have, and an exit code is what makes it a conversation rather
 * than a number scrolled past.
 *
 * ## What it reads
 *
 * `pulumi preview --json` — the plan, not the program. A program has to be executed to
 * know what it creates: replica counts come from config, the profile decides a rollout
 * strategy, and a conditional spread can add or remove a whole container. The plan is
 * what will actually be applied, which is the only thing worth pricing.
 *
 * ## What it prices, and the two judgement calls in it
 *
 * **Requested capacity, not object count.** Ten ConfigMaps cost nothing; one Deployment
 * asking for 4 vCPU costs real money. So the unit is `resources.requests` summed over
 * the containers of each pod and multiplied by the replica count — which is what a
 * cluster autoscaler ends up buying nodes for.
 *
 * **An HPA's `maxReplicas`, not its `minReplicas`.** A budget that assumes the quiet
 * hour is not a budget; the number to defend is the one the account is charged on the
 * day traffic arrives, which is the ceiling the autoscaler is allowed to reach. This
 * single decision roughly doubles the estimate for this stack, and that is the point.
 *
 * A Job is counted at zero. It is bounded work — the migration runs for seconds and the
 * pod is gone — and spreading it over a month would be a made-up number. Where that
 * stops being true is a CronJob, which is why a CronJob is not in the free list below
 * and would be refused as unpriced rather than quietly costed at nothing.
 *
 * ## The failure nobody notices
 *
 * A cost model's real failure mode is not a wrong rate, it is a resource type the table
 * has never heard of silently costing zero — which is exactly how the expensive thing
 * gets through, because the expensive thing is usually the new thing. So every type in
 * the plan must be in one of two lists: priced, or explicitly free. Anything else fails
 * the gate by name and asks for a decision.
 */

/**
 * The rate card. One place, dated, and every line has a source in the README's CI/CD
 * section — a rate table with no date is a rate table nobody can audit.
 *
 * Measured against AWS us-east-1 on-demand, **26.11.2026**. Compute is priced with the
 * published Fargate rates rather than an instance type, because the unit a pod spec
 * declares is vCPU and memory and Fargate is the one AWS product that sells exactly
 * those two, separately and at a published number. An EC2 instance would mean first
 * guessing a bin-packing.
 */
const RATES = Object.freeze({
    /** $/vCPU-hour, AWS Fargate, Linux/x86, us-east-1. */
    cpuHour: 0.04048,
    /** $/GB-hour, AWS Fargate, Linux/x86, us-east-1. */
    memoryGbHour: 0.004445,
    /** $/GiB-month, Amazon EBS gp3. */
    storageGibMonth: 0.08,
    /** $/hour for one Network Load Balancer, before capacity units. */
    loadBalancerHour: 0.0225,
});

/**
 * Hours in the billing month AWS uses in its own examples. 730 and not 720: it is
 * 8760/12, which is what every published monthly figure on their pricing pages assumes.
 */
const HOURS_PER_MONTH = 730;

/**
 * The one label that lets a pull request past this gate.
 *
 * Written here and quoted verbatim in the README, because a bypass nobody can find is a
 * bypass that gets implemented a second time, badly, by somebody in a hurry.
 */
const BYPASS_LABEL = 'cost-approved';

/** Pod-bearing types: replicas × the sum of their containers' requests. */
const WORKLOAD_TYPES = new Set([
    'kubernetes:apps/v1:Deployment',
    'kubernetes:apps/v1:StatefulSet',
    'kubernetes:apps/v1:DaemonSet',
    'kubernetes:apps/v1:ReplicaSet',
]);

/**
 * Types that genuinely cost nothing, each because of something true about it rather than
 * because nobody got round to pricing it. A ConfigMap is a row in etcd. A Namespace is a
 * label. An HPA is a controller loop — it causes spend, and that spend is already counted
 * through the `maxReplicas` it imposes on the Deployment it targets, so pricing it again
 * here would be double counting.
 */
const FREE_TYPES = new Set([
    'pulumi:pulumi:Stack',
    'pulumi:providers:kubernetes',
    'kubernetes:core/v1:Namespace',
    'kubernetes:core/v1:ConfigMap',
    'kubernetes:core/v1:Secret',
    'kubernetes:core/v1:ServiceAccount',
    'kubernetes:policy/v1:PodDisruptionBudget',
    'kubernetes:autoscaling/v2:HorizontalPodAutoscaler',
    'kubernetes:batch/v1:Job',
]);

/** One line of the estimate: what it is, what it costs, and the arithmetic behind it. */
class CostLine {
    constructor(name, type, usd, detail) {
        this.name = name;
        this.type = type;
        this.usd = usd;
        this.detail = detail;
    }
}

/** The whole estimate: the priced lines, and the types nothing knew how to price. */
class Estimate {
    constructor(lines, unpriced) {
        this.lines = lines;
        this.unpriced = unpriced;
    }

    get total() {
        return this.lines.reduce((sum, line) => sum + line.usd, 0);
    }
}

/**
 * Kubernetes writes CPU as cores or as thousandths of one: `2`, `1.5`, `500m`.
 */
function cpuCores(quantity) {
    if (quantity === undefined || quantity === null) {
        return 0;
    }

    const text = String(quantity);
    return text.endsWith('m') ? Number.parseFloat(text) / 1000 : Number.parseFloat(text);
}

const BINARY_SUFFIXES = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
const DECIMAL_SUFFIXES = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/**
 * Memory and storage, in GiB.
 *
 * The rates are quoted per GB and the quantities are overwhelmingly written in GiB, so
 * the conversion is left as 1:1 deliberately: a GiB is 7,4 % larger than a GB, which
 * makes every estimate here that much *too high*. A budget may be wrong in one direction
 * only, and this is the one.
 */
function gibibytes(quantity) {
    if (quantity === undefined || quantity === null) {
        return 0;
    }

    const text = String(quantity).trim();

    for (const [suffix, factor] of Object.entries(BINARY_SUFFIXES)) {
        if (text.endsWith(suffix)) {
            return (Number.parseFloat(text) * factor) / 2 ** 30;
        }
    }

    for (const [suffix, factor] of Object.entries(DECIMAL_SUFFIXES)) {
        if (text.endsWith(suffix)) {
            return (Number.parseFloat(text) * factor) / 2 ** 30;
        }
    }

    return Number.parseFloat(text) / 2 ** 30;
}

function podRequests(podSpec) {
    const containers = [...(podSpec?.containers ?? []), ...(podSpec?.initContainers ?? [])];

    return containers.reduce(
        (totals, container) => {
            const requests = container.resources?.requests ?? {};
            totals.cpu += cpuCores(requests.cpu);
            totals.memory += gibibytes(requests.memory);
            return totals;
        },
        { cpu: 0, memory: 0 },
    );
}

/**
 * The steps that describe the stack **after** the plan is applied.
 *
 * A `delete` is priced out by its absence rather than as a negative number, and a `same`
 * step is as much a part of next month's bill as a `create` — a gate that only looked at
 * what changed would report a budget of nothing for a plan that changes nothing while the
 * stack keeps costing what it costs.
 */
function survivingSteps(plan) {
    return (plan.steps ?? []).filter((step) => step.op !== 'delete' && step.newState !== undefined);
}

/** Which Deployment each HPA points at, and the ceiling it may take it to. */
function autoscalerCeilings(steps) {
    const ceilings = new Map();

    for (const step of steps) {
        if (step.newState.type !== 'kubernetes:autoscaling/v2:HorizontalPodAutoscaler') {
            continue;
        }

        const spec = step.newState.inputs?.spec ?? {};
        const target = spec.scaleTargetRef?.name;

        if (target !== undefined && spec.maxReplicas !== undefined) {
            ceilings.set(target, Number(spec.maxReplicas));
        }
    }

    return ceilings;
}

function priceWorkload(step, ceilings) {
    const inputs = step.newState.inputs ?? {};
    const name = inputs.metadata?.name ?? step.urn;
    const declared = Number(inputs.spec?.replicas ?? 1);
    const ceiling = ceilings.get(name);
    const replicas = ceiling === undefined ? declared : Math.max(declared, ceiling);

    const requests = podRequests(inputs.spec?.template?.spec);
    const cpuUsd = requests.cpu * replicas * RATES.cpuHour * HOURS_PER_MONTH;
    const memoryUsd = requests.memory * replicas * RATES.memoryGbHour * HOURS_PER_MONTH;

    const how =
        ceiling === undefined
            ? `${replicas} replica(s)`
            : `${replicas} replica(s) — the HPA ceiling, not the declared ${declared}`;

    return new CostLine(
        name,
        step.newState.type,
        cpuUsd + memoryUsd,
        `${how} x ${requests.cpu.toFixed(3)} vCPU + ${requests.memory.toFixed(3)} GiB`,
    );
}

function priceClaim(step) {
    const inputs = step.newState.inputs ?? {};
    const name = inputs.metadata?.name ?? step.urn;
    const size = gibibytes(inputs.spec?.resources?.requests?.storage);

    return new CostLine(
        name,
        step.newState.type,
        size * RATES.storageGibMonth,
        `${size.toFixed(1)} GiB of gp3`,
    );
}

/**
 * A Service costs nothing unless it is a `LoadBalancer`, in which case it quietly
 * provisions one and bills by the hour whether or not anything is behind it. ClusterIP
 * and NodePort are routing rules on machines already paid for.
 */
function priceService(step) {
    const inputs = step.newState.inputs ?? {};
    const name = inputs.metadata?.name ?? step.urn;
    const type = inputs.spec?.type ?? 'ClusterIP';

    if (type !== 'LoadBalancer') {
        return new CostLine(name, step.newState.type, 0, `type: ${type}`);
    }

    return new CostLine(
        name,
        step.newState.type,
        RATES.loadBalancerHour * HOURS_PER_MONTH,
        'one load balancer, by the hour, before capacity units',
    );
}

export function estimate(plan) {
    const steps = survivingSteps(plan);
    const ceilings = autoscalerCeilings(steps);

    const lines = [];
    const unpriced = [];

    for (const step of steps) {
        const type = step.newState.type;

        if (WORKLOAD_TYPES.has(type)) {
            lines.push(priceWorkload(step, ceilings));
        } else if (type === 'kubernetes:core/v1:PersistentVolumeClaim') {
            lines.push(priceClaim(step));
        } else if (type === 'kubernetes:core/v1:Service') {
            lines.push(priceService(step));
        } else if (!FREE_TYPES.has(type)) {
            unpriced.push(type);
        }
    }

    return new Estimate(lines, [...new Set(unpriced)]);
}

function budgetFrom(raw) {
    if (raw === undefined || raw.trim() === '') {
        throw new Error(
            'COST_BUDGET_USD is not set. A gate with no threshold is a print statement.',
        );
    }

    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`COST_BUDGET_USD="${raw}" is not a non-negative number`);
    }

    return parsed;
}

function main() {
    const file = process.env.PLAN_JSON ?? 'plan.json';
    const budget = budgetFrom(process.env.COST_BUDGET_USD);

    let plan;

    try {
        plan = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(
            `${file} could not be read as a plan (${error.message}). Produce one with: ` +
                'npm run up -- --json  — or in the pipeline, pulumi preview --json > plan.json',
        );
    }

    const result = estimate(plan);
    const total = result.total;

    for (const line of result.lines) {
        console.error(`  ${line.usd.toFixed(2).padStart(8)}  ${line.name} — ${line.detail}`);
    }

    emit('budget-usd', budget.toFixed(2));
    emit('plan-usd', total.toFixed(2));
    emit('priced-resources', result.lines.length);
    emit('unpriced-resources', result.unpriced.length);

    const withinBudget = total <= budget;
    const everythingPriced = result.unpriced.length === 0;
    const bypassed = process.env.COST_GATE_BYPASS === '1';

    emit('gate', withinBudget && everythingPriced ? 'pass' : 'fail');

    if (!everythingPriced) {
        console.error(
            `\nnothing in this script knows what these cost: ${result.unpriced.join(', ')}\n` +
                'Add each to the rate card or to the free list, with a reason. A type nobody ' +
                'priced is costed at zero, and the expensive thing is usually the new thing.\n',
        );
    }

    if (!withinBudget) {
        console.error(
            `\n$${total.toFixed(2)} a month is over the $${budget.toFixed(2)} budget.\n` +
                'Either the change is worth it — label the pull request `cost-approved`, which ' +
                'is a decision somebody signs for — or the replica count, the HPA ceiling or the ' +
                'volume is larger than it needs to be.\n',
        );
    }

    /**
     * The label is a decision, and a decision is allowed to overrule an estimate.
     *
     * A cost gate with no way past it is a cost gate that gets deleted the first Friday
     * it stands between somebody and a fix. `cost-approved` on the pull request is the
     * way past, and what it buys is narrow on purpose: the verdict above is **not**
     * rewritten — `gate=fail` still goes into the evidence, beside `bypass=cost-approved`
     * — so the artifact records that this cost more than the budget and that a named
     * person said yes anyway. A bypass that flipped the verdict to `pass` would erase the
     * only thing worth keeping.
     *
     * It does not cover `unpriced-resources`. That is not a judgement about money, it is
     * this script admitting it does not know what something costs, and approving a number
     * nobody has is not a decision anybody can make.
     */
    if (bypassed && !withinBudget) {
        emit('bypass', BYPASS_LABEL);
        console.error(
            `\nover budget, and allowed through by the \`${BYPASS_LABEL}\` label. ` +
                'The verdict above is unchanged and is in the evidence.\n',
        );
    }

    if ((!withinBudget && !bypassed) || !everythingPriced) {
        process.exitCode = 1;
    }
}

try {
    main();
} catch (error) {
    console.error(`\ncost gate failed: ${error.message}\n`);
    process.exitCode = 2;
}
