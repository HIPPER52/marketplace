/**
 * Reading Prometheus's text format, because a counter delta is two reads and a
 * subtraction.
 *
 * The demos deliberately do not ask Prometheus for these numbers. A scrape happens on
 * Prometheus's schedule, so "ask the server" means waiting for an interval and then
 * trusting that it landed; scraping `/metrics` twice gives the same arithmetic with
 * nothing in between to go wrong. It is also the only way to count **series**, which is
 * what the cardinality half of `demo:metrics` is about: a series is a line here.
 */

/** Named, because every function below returns a list of them. */
export class Sample {
    constructor(name, labels, value) {
        this.name = name;
        this.labels = labels;
        this.value = value;
    }
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(.+)$/;

export function parseExposition(text) {
    const samples = [];

    for (const line of text.split('\n')) {
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }

        const match = LINE.exec(line);

        if (match === null) {
            continue;
        }

        samples.push(new Sample(match[1], parseLabels(match[3] ?? ''), Number(match[4])));
    }

    return samples;
}

function parseLabels(raw) {
    const labels = {};

    for (const pair of raw.match(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"/g) ?? []) {
        const at = pair.indexOf('=');
        labels[pair.slice(0, at)] = pair.slice(at + 2, -1).replace(/\\(.)/g, '$1');
    }

    return labels;
}

export function samplesOf(samples, name, match = {}) {
    return samples.filter(
        (sample) =>
            sample.name === name &&
            Object.entries(match).every(([key, value]) => sample.labels[key] === value),
    );
}

export function sumOf(samples, name, match = {}) {
    return samplesOf(samples, name, match).reduce((total, sample) => total + sample.value, 0);
}

/** How many time series this counter has, which is the number a label multiplies. */
export function seriesOf(samples, name) {
    return samplesOf(samples, name).length;
}

export async function scrape(baseUrl) {
    const response = await fetch(`${baseUrl}/metrics`);

    if (!response.ok) {
        throw new Error(`GET /metrics answered ${response.status}`);
    }

    return parseExposition(await response.text());
}
