# Broken on purpose

Everything under this directory is input a gate has to **refuse**. None of it is ever
compiled into `dist/`, imported by the service, or reached by `npm run check` —
`tsconfig.json` includes `src`, `test` and `scripts`, and this is none of them.

It exists because of one sentence in the assignment: a gate has to be shown working on a
correct input _and_ on a broken one. A gate that has only ever seen green code is not
known to be a gate — it is known to be a command that exits 0, which is also what
`true` does. `npm run demo:gates` runs each of the four over both, and fails the process
if any of them answers the same way twice.

| File                                                   | Which gate refuses it | Why                                             |
| ------------------------------------------------------ | --------------------- | ----------------------------------------------- |
| `types/broken.ts`                                      | `tsc --noEmit`        | assigns a decimal string to `Order.total_cents` |
| `architecture/orders/repositories/leaky.repository.ts` | dependency-cruiser    | a repository importing the HTTP framework       |

The contract gate's broken input is not here: it is **generated** from
`openapi/openapi.yaml` at run time, by deleting a required response field. A committed
copy of the spec with one field missing is a second source of truth that goes stale the
first time the real spec moves, and then the gate is demonstrated against a contract
nobody has.
