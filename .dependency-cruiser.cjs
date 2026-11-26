/**
 * Four rules about which layer may reach which, checked by a machine.
 *
 * Every one of them is a sentence this repository already says in prose — in the README,
 * in a comment, in a code review somebody did once. The difference is that a sentence
 * holds until somebody is in a hurry, and a rule with an exit code holds afterwards.
 *
 * The rules are deliberately few. A ruleset that forbids everything is a ruleset people
 * disable; these four are the edges that actually went wrong in this project or would
 * cost the most if they did.
 */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment:
                'A cycle between modules means neither can be read, tested or deleted on ' +
                'its own, and it is the one architectural defect that compounds.\n' +
                '\n' +
                'Entities are excluded, and the exclusion is a fact about TypeORM rather ' +
                'than a concession. A bidirectional relation is two decorators pointing at ' +
                'each other — Order declares @OneToMany(() => OrderItem) and OrderItem ' +
                'declares @ManyToOne(() => Order) — so each file names the other type and ' +
                'the pair is circular by construction. There are exactly three such cycles ' +
                'here (order ↔ user, order ↔ order-item, order-item ↔ product) and all ' +
                'three are relations the mapper needs. The rule still fires on any cycle ' +
                'that *starts* outside entities, which is every cycle a person could ' +
                'introduce by mistake.',
            from: { pathNot: '/entities/' },
            to: { circular: true },
        },
        {
            name: 'domain-not-to-http',
            severity: 'error',
            comment:
                'A service, a repository or an entity must not import the HTTP framework. ' +
                'The edge translates HTTP into a call and a refusal into a status; the ' +
                'moment a repository knows what a 404 is, the domain is an HTTP handler ' +
                'with extra steps. This is the rule #22 leaned on when demo:outbox had to ' +
                'call PlaceOrderService directly, below the layer that knows about tokens.',
            from: { path: '/(services|repositories|entities)/' },
            to: { path: 'node_modules/(express|@nestjs/platform-express)' },
        },
        {
            name: 'repositories-not-to-controllers',
            severity: 'error',
            comment:
                'The dependency points one way. A repository that imports a controller has ' +
                'turned the stack upside down, and the next step is a cycle.',
            from: { path: '/repositories/' },
            to: { path: '/controllers/' },
        },
        {
            name: 'entities-not-to-services',
            severity: 'error',
            comment:
                'An entity describes a row. A row that reaches for a service is a row that ' +
                'cannot be constructed in a test without raising half the application.',
            from: { path: '/entities/' },
            to: { path: '/services/' },
        },
    ],

    options: {
        doNotFollow: { path: 'node_modules' },
        // Generated from openapi.yaml on every build and never hand-written, so it has no
        // architecture of its own to judge.
        exclude: { path: '/generated/' },
        tsConfig: { fileName: 'tsconfig.json' },
        tsPreCompilationDeps: true,
        enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['require', 'node'] },
    },
};
