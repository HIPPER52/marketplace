import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envSchema } from '../src/config/schemas/env.schema';

const EXAMPLE_PATH = resolve(process.cwd(), '.env.example');

interface ExampleEntry {
    line: number;
    documented: boolean;
}

function readExample(): Map<string, ExampleEntry> {
    const entries = new Map<string, ExampleEntry>();
    const lines = readFileSync(EXAMPLE_PATH, 'utf8').split('\n');

    lines.forEach((raw, index) => {
        const match = /^([A-Z][A-Z0-9_]*)=/.exec(raw.trim());

        if (!match?.[1]) {
            return;
        }

        let cursor = index - 1;
        let documented = false;

        while (cursor >= 0 && lines[cursor]?.trim() !== '') {
            if (lines[cursor]?.trim().startsWith('#')) {
                documented = true;
                break;
            }
            cursor -= 1;
        }

        entries.set(match[1], { line: index + 1, documented });
    });

    return entries;
}

function main(): void {
    const shape = envSchema.shape as Record<
        string,
        { safeParse: (value: unknown) => { success: boolean } }
    >;
    const schemaKeys = Object.keys(shape);
    const example = readExample();

    const missing = schemaKeys.filter((key) => !example.has(key));
    const stale = [...example.keys()].filter((key) => !schemaKeys.includes(key));
    const undocumented = schemaKeys.filter((key) => example.get(key)?.documented === false);

    const problems: string[] = [];

    if (missing.length > 0) {
        problems.push(
            `Missing from .env.example (present in the schema):\n${missing
                .map((key) => {
                    const required = !shape[key]?.safeParse(undefined).success;
                    return `  ${key}${required ? '   (required)' : ''}`;
                })
                .join('\n')}`,
        );
    }

    if (stale.length > 0) {
        problems.push(
            `Present in .env.example but not in the schema — the schema dropped them:\n${stale
                .map((key) => `  ${key} (line ${example.get(key)?.line})`)
                .join('\n')}`,
        );
    }

    if (undocumented.length > 0) {
        problems.push(
            `Undocumented — every variable needs a comment above it:\n${undocumented
                .map((key) => `  ${key} (line ${example.get(key)?.line})`)
                .join('\n')}`,
        );
    }

    if (problems.length > 0) {
        console.error('.env.example is out of sync with the environment schema.\n');
        console.error(problems.join('\n\n'));
        console.error('\nUpdate .env.example, then run `npm run check:env` again.');
        process.exit(1);
    }

    console.log(`.env.example is in sync with the schema (${schemaKeys.length} variables).`);
}

main();
