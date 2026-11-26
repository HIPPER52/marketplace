import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { run } from '../scripts/lib/shell.mjs';
import { IMAGE_REF, REPO_ROOT } from '../scripts/lib/stack.mjs';

/**
 * Four quality gates, each shown refusing something and accepting something else.
 *
 *   npm run demo:gates
 *
 * The assignment asks for gates that block a merge, and the only way to know a gate
 * blocks anything is to hand it something it must refuse. A command that exits 0 on the
 * repository as it stands is indistinguishable from `true`; it becomes evidence the
 * moment the same command, with the same configuration, exits non-zero on an input that
 * deserves it. So every gate here runs twice, and the demo fails the process if any of
 * them answers the same way both times.
 *
 * What is deliberately **not** varied between the two runs is the configuration. The
 * type gate compiles both inputs with the options in `tsconfig.json`; the architecture
 * gate judges both with the rules in `.dependency-cruiser.cjs`; the contract gate runs
 * one oasdiff invocation twice. A demo that reached its red answer by also editing the
 * rules would be proving that a rule can be written to fail, which nobody doubted.
 *
 * Printed keys, all eight of them exit codes:
 *
 *   types-ok / types-broken              tsc --noEmit
 *   contract-ok / contract-broken        oasdiff breaking --fail-on ERR
 *   architecture-ok / architecture-broken dependency-cruiser
 *   image-ok / image-broken              trivy, against a threshold
 */

/** Pinned for the reason every other tool here is: its output and its exit codes are an interface. */
const OASDIFF_IMAGE = 'tufin/oasdiff:v1.41.0';

const SPEC = join(REPO_ROOT, 'openapi', 'openapi.yaml');

/** What each half of a gate answers with: the exit code, and one line a human can read. */
class GateVerdict {
    constructor(code, summary) {
        this.code = code;
        this.summary = summary;
    }
}

/** A gate is its name and the two inputs it is held to. Both halves return a GateVerdict. */
class Gate {
    constructor(name, ok, broken) {
        this.name = name;
        this.ok = ok;
        this.broken = broken;
    }
}

function npx(args, options = {}) {
    return run('npx', ['--no-install', ...args], { cwd: REPO_ROOT, ...options });
}

// ---------------------------------------------------------------------------------------
// 1. Types
//
// The correct input is this repository: `tsconfig.json` covers src, test and scripts.
// The broken one is demo/fixtures/types, whose own tsconfig *extends* this one — same
// strictness, same target, same lib — so the single difference between the two runs is
// the file list. The fixture assigns a decimal string to `Order.total_cents`, which is
// the mistake the contract exists to make impossible: openapi.yaml says integer minor
// units, openapi-typescript turns that into `number`, and the compiler does the rest.
// ---------------------------------------------------------------------------------------

function typesOk() {
    const result = npx(['tsc', '--noEmit', '-p', 'tsconfig.json']);
    return new GateVerdict(result.code, 'src + test + scripts');
}

function typesBroken() {
    const result = npx(['tsc', '--noEmit', '-p', 'demo/fixtures/types/tsconfig.json']);
    const first = result.output.trim().split('\n')[0] ?? '';
    return new GateVerdict(result.code, first);
}

// ---------------------------------------------------------------------------------------
// 2. Contract
//
// Both inputs are *changes*, and that is the point: a gate that only distinguishes "the
// file moved" from "the file did not" is a diff, not a contract gate. The accepted
// revision adds a whole new operation — additive, nobody's client notices. The refused
// one drops `total_cents` from `Order.required`, which oasdiff reports as
// `response-property-became-optional` against four operations at once, because four of
// them answer with an Order.
//
// Neither revision is ever written into openapi/openapi.yaml. They are generated into a
// temporary directory, handed to the container read-only, and deleted. A committed copy
// of the spec with one field missing would be a second source of truth, and it would be
// wrong the first time the real spec moved.
// ---------------------------------------------------------------------------------------

const ADDITIVE_PATH = `  /products/{productId}/similar:
    get:
      operationId: listSimilarProducts
      summary: Products a buyer looking at this one might also want.
      parameters:
        - name: productId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: A page of similar products.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ProductPage"

`;

function additiveRevision(spec) {
    const revised = spec.replace('\ncomponents:\n', `\n${ADDITIVE_PATH}components:\n`);

    if (revised === spec) {
        throw new Error('the additive mutation did not apply: no top-level `components:` found');
    }

    return revised;
}

function breakingRevision(spec) {
    const before = 'required: [id, status, items, total_cents, currency, created_at]';
    const after = 'required: [id, status, items, currency, created_at]';
    const revised = spec.replace(before, after);

    if (revised === spec) {
        throw new Error(
            `the breaking mutation did not apply: "${before}" is no longer in the spec`,
        );
    }

    return revised;
}

function oasdiff(directory, revisionFile) {
    const result = run('docker', [
        'run',
        '--rm',
        '--volume',
        `${directory}:/specs:ro`,
        OASDIFF_IMAGE,
        'breaking',
        '/specs/base.yaml',
        `/specs/${revisionFile}`,
        // Without this oasdiff prints the breaking changes and exits 0 — it reports by
        // default and fails only when asked to. A gate that printed a wall of errors and
        // let the merge through is the worst of both.
        '--fail-on',
        'ERR',
        '--color',
        'never',
    ]);

    const headline = result.output.trim().split('\n')[0] ?? '';
    return new GateVerdict(result.code, headline);
}

function withSpecs(body) {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-gates-'));

    try {
        const spec = readFileSync(SPEC, 'utf8');

        writeFileSync(join(directory, 'base.yaml'), spec);
        writeFileSync(join(directory, 'additive.yaml'), additiveRevision(spec));
        writeFileSync(join(directory, 'breaking.yaml'), breakingRevision(spec));

        return body(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------
// 3. Architecture
//
// One ruleset, two directories. `src/` obeys it; demo/fixtures/architecture holds a file
// under a `repositories/` folder that imports express, which is `domain-not-to-http`.
// The rules match on the folder a module lives in rather than on an absolute prefix,
// which is what lets the fixture be judged by the identical configuration.
// ---------------------------------------------------------------------------------------

function depcruise(target) {
    const result = npx(['depcruise', target, '--config', '.dependency-cruiser.cjs']);
    const violation = result.output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('error '));

    return new GateVerdict(result.code, violation ?? 'no dependency violations found');
}

// ---------------------------------------------------------------------------------------
// 4. Image
//
// `npm run scan` already computes its verdict — it counts the findings and compares them
// against a threshold, so the same report gives two different answers at two thresholds.
// That is exactly what is needed here: the accepted run is the working threshold from
// scripts/scan.mjs, the refused one is `SCAN_MAX=-1`, under which no image can pass.
//
// It is the one gate that needs something built. The image is produced if it is not on
// the machine, because a demo that tells somebody to go and run another command first is
// a demo that gets run once.
// ---------------------------------------------------------------------------------------

function ensureImage() {
    if (run('docker', ['image', 'inspect', IMAGE_REF]).code === 0) {
        return;
    }

    console.error(`${IMAGE_REF} is not on this machine; building it first (this takes a while)`);

    const built = run('npm', ['run', 'image:build'], { cwd: REPO_ROOT, stdio: 'inherit' });

    if (built.code !== 0) {
        throw new Error(`npm run image:build exited ${built.code}`);
    }
}

function scan(max) {
    const result = run('npm', ['run', '--silent', 'scan'], {
        cwd: REPO_ROOT,
        env: { ...process.env, SCAN_MAX: String(max) },
    });

    const numbers = result.output
        .split('\n')
        .filter((line) => /^(found|max-allowed|gate)=/.test(line))
        .join(' ');

    return new GateVerdict(result.code, numbers.trim());
}

const GATES = [
    new Gate('types', typesOk, typesBroken),
    new Gate(
        'contract',
        () => withSpecs((directory) => oasdiff(directory, 'additive.yaml')),
        () => withSpecs((directory) => oasdiff(directory, 'breaking.yaml')),
    ),
    new Gate(
        'architecture',
        () => depcruise('src'),
        () => depcruise('demo/fixtures/architecture'),
    ),
    new Gate(
        'image',
        () => scan(''),
        () => scan(-1),
    ),
];

function main() {
    ensureImage();

    let oneSided = 0;

    for (const gate of GATES) {
        const ok = gate.ok();
        const broken = gate.broken();

        emit(`${gate.name}-ok`, ok.code);
        emit(`${gate.name}-broken`, broken.code);

        console.error(`  ${gate.name} accepted: ${ok.summary}`);
        console.error(`  ${gate.name} refused:  ${broken.summary}`);

        // A gate is two facts, and only together are they one. Passing everything is a
        // broken gate wearing a green tick; failing everything is a gate nobody can
        // merge past, which gets switched off within the week.
        if (ok.code !== 0 || broken.code === 0) {
            oneSided += 1;
        }
    }

    emit('gates', GATES.length);
    emit('one-sided', oneSided);

    if (oneSided !== 0) {
        fail(
            `${oneSided} gate(s) did not answer differently on the two inputs. ` +
                'A gate that cannot fail is not a gate, and one that cannot pass is not a gate either.',
        );
    }
}

try {
    main();
} catch (error) {
    console.error(`\ndemo:gates failed: ${error.message}\n`);
    process.exitCode = 2;
}
