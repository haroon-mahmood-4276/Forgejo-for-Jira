/**
 * Local test suite.
 *
 * Runs the real source files against in-memory stubs of the Forge platform, so
 * it needs no Forge installation, no Jira site and no Forgejo instance.
 *
 *   npm test
 *
 * Covered: HMAC verification and its failure modes, connection-scoped webhook
 * routing, issue-key extraction, every devinfo mapper, batching against Jira's
 * 400-entity limit, build and deployment submission, and the backfill state
 * machine.
 */

import crypto from 'crypto';
import assert from 'node:assert';
import { harness } from './stubs.mjs';

// The stubs install a loader hook, so every import below must come after it.
const { handleForgejoWebhook } = await import('../src/webhook.js');
const { handleCiStatus } = await import('../src/ci-status.js');
const { verifySignature, getRawBody, readSignature } = await import(
    '../src/lib/verify-signature.js'
);
const { extractIssueKeys } = await import('../src/lib/issue-keys.js');
const devinfo = await import('../src/lib/devinfo.js');
const storage = await import('../src/lib/storage.js');
const { handler: backfillHandler, startBackfill } = await import('../src/backfill.js');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CONNECTION_ID = 'testconnection01';
const SECRET = 'local-test-secret';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
    harness.reset();
    await seedConnection();

    try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed += 1;
    } catch (error) {
        console.log(`  FAIL  ${name}`);
        console.log(`        ${error.message}`);
        failed += 1;
        failures.push(name);
    }
}

function group(name) {
    console.log(`\n${name}`);
}

/** Every test starts from one authorized connection with one repository. */
async function seedConnection() {
    await storage.saveConnection({
        id: CONNECTION_ID,
        name: 'Test Forgejo',
        instanceUrl: 'https://forgejo.example.com',
        clientId: 'client-id',
        createdAt: 1
    });
    await storage.saveConnectionSecrets(CONNECTION_ID, {
        clientSecret: 'client-secret',
        webhookSecret: SECRET
    });
    await storage.saveToken(CONNECTION_ID, {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3_600_000,
        username: 'tester'
    });
}

function sign(body, secret = SECRET) {
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function request(payload, { secret = SECRET, event = 'push', signature, connectionId = CONNECTION_ID } = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

    return {
        body,
        queryParameters: connectionId ? { c: [connectionId] } : {},
        headers: {
            'X-Forgejo-Signature': [signature ?? sign(body, secret)],
            'X-Forgejo-Event': [event]
        }
    };
}

/** The devinfo body of the nth Jira call. */
function submittedBody(index = 0) {
    return JSON.parse(harness.jiraRequests[index].options.body);
}

function submittedRepository(index = 0) {
    return submittedBody(index).repositories[0];
}

const repository = {
    id: 42,
    name: 'test-repo',
    full_name: 'acme/test-repo',
    // Reading a pull request's reviews needs the owner, which Forgejo always
    // sends on the repository object.
    owner: { login: 'acme' },
    html_url: 'https://forgejo.example.com/acme/test-repo',
    description: 'A test repository'
};

function pushPayload({ messages = ['BHP-1 add widget'] } = {}) {
    return {
        ref: 'refs/heads/main',
        repository,
        commits: messages.map((message, index) => ({
            id: String(index).padStart(40, 'a'),
            message,
            url: `https://forgejo.example.com/acme/test-repo/commit/abc${index}`,
            author: { name: 'Test User', email: 'test@example.com', username: 'testuser' },
            timestamp: '2026-08-09T10:00:00Z',
            added: ['a.txt'],
            removed: [],
            modified: ['b.txt']
        }))
    };
}

// ---------------------------------------------------------------------------

group('Signature verification');

await test('accepts a correctly signed body', () => {
    const body = '{"hello":"world"}';
    assert.strictEqual(verifySignature(body, sign(body), SECRET), true);
});

await test('rejects a signature made with a different secret', () => {
    const body = '{"hello":"world"}';
    assert.strictEqual(verifySignature(body, sign(body, 'other'), SECRET), false);
});

await test('rejects a truncated signature without throwing', () => {
    const body = '{"hello":"world"}';
    assert.strictEqual(verifySignature(body, sign(body).slice(0, 32), SECRET), false);
});

await test('rejects a non-hex signature', () => {
    assert.strictEqual(verifySignature('{}', 'not-hex-at-all!!', SECRET), false);
});

await test('rejects a missing signature', () => {
    assert.strictEqual(verifySignature('{}', undefined, SECRET), false);
});

await test('rejects when no secret is configured', () => {
    assert.strictEqual(verifySignature('{}', sign('{}'), undefined), false);
});

await test('hashes the raw bytes, not re-serialised JSON', () => {
    // Key order and whitespace change the bytes but not the parsed object, so a
    // handler that re-serialises before hashing would reject this valid delivery.
    const body = '{ "b": 2,\n  "a": 1 }';
    assert.strictEqual(verifySignature(body, sign(body), SECRET), true);
    assert.notStrictEqual(JSON.stringify(JSON.parse(body)), body);
});

/**
 * Forge's web trigger deletes every line feed from the request body before the
 * function sees it. Forgejo signs the pretty-printed bytes it actually sent, so
 * without reconstruction each of these deliveries is rejected as a forgery.
 */
const stripNewlines = (body) => body.replace(/\n/g, '');

await test('accepts a pretty-printed body whose newlines Forge stripped', () => {
    const sent = JSON.stringify({ ref: 'refs/heads/PAKDSS-1', commits: [] }, null, 2);
    const signature = sign(sent);

    assert.ok(sent.includes('\n'), 'fixture must contain the newlines Forge removes');
    assert.strictEqual(verifySignature(stripNewlines(sent), signature, SECRET), true);
});

await test('reconstructs Go\'s HTML escaping when rebuilding the signed body', () => {
    // Go's encoding/json escapes < > & to their \u00xx forms by default;
    // JSON.stringify leaves them literal. A commit message containing "&" is
    // ordinary, so getting this wrong would reject many real deliveries.
    const sent = JSON.stringify({ message: 'fix A & B <div> ok' }, null, 2)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');

    assert.strictEqual(verifySignature(stripNewlines(sent), sign(sent), SECRET), true);
});

await test('still rejects a stripped body signed with the wrong secret', () => {
    // Reconstruction must widen what verifies, not what passes.
    const sent = JSON.stringify({ ref: 'refs/heads/PAKDSS-1' }, null, 2);
    assert.strictEqual(verifySignature(stripNewlines(sent), sign(sent, 'other'), SECRET), false);
});

await test('rejects a stripped body whose payload was tampered with', () => {
    const sent = JSON.stringify({ ref: 'refs/heads/PAKDSS-1' }, null, 2);
    const tampered = JSON.stringify({ ref: 'refs/heads/EVIL-1' }, null, 2);
    assert.strictEqual(verifySignature(stripNewlines(tampered), sign(sent), SECRET), false);
});

await test('decodes a base64-encoded body before hashing', () => {
    const body = '{"hello":"world"}';
    const encoded = Buffer.from(body, 'utf8').toString('base64');
    assert.strictEqual(getRawBody({ body: encoded, isBase64Encoded: true }), body);
});

await test('finds the signature header case-insensitively', () => {
    assert.strictEqual(readSignature({ 'X-Forgejo-Signature': ['abc'] }), 'abc');
    assert.strictEqual(readSignature({ 'x-gitea-signature': ['def'] }), 'def');
});

// ---------------------------------------------------------------------------

group('Issue key extraction');

await test('extracts a key from a commit message', () => {
    assert.deepStrictEqual(extractIssueKeys('BHP-1 add widget'), ['BHP-1']);
});

await test('extracts several keys and de-duplicates them', () => {
    assert.deepStrictEqual(extractIssueKeys('ABC-1 and DEF-2 and ABC-1 again'), ['ABC-1', 'DEF-2']);
});

await test('ignores lowercase and single-letter project keys', () => {
    assert.deepStrictEqual(extractIssueKeys('abc-1 fixes a-2'), []);
});

await test('reads across several fields at once', () => {
    assert.deepStrictEqual(extractIssueKeys('ABC-1 title', 'feature/DEF-2-branch'), [
        'ABC-1',
        'DEF-2'
    ]);
});

await test('tolerates null and undefined fields', () => {
    assert.deepStrictEqual(extractIssueKeys(undefined, null, 'ABC-9'), ['ABC-9']);
});

// ---------------------------------------------------------------------------

group('Webhook routing and authentication');

await test('rejects a delivery with no connection identifier', async () => {
    const response = await handleForgejoWebhook(request(pushPayload(), { connectionId: null }));
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('rejects a delivery for an unknown connection', async () => {
    const response = await handleForgejoWebhook(
        request(pushPayload(), { connectionId: 'nosuchconnection' })
    );
    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('rejects a delivery signed with another connection\'s secret', async () => {
    const response = await handleForgejoWebhook(request(pushPayload(), { secret: 'wrong-secret' }));
    assert.strictEqual(response.statusCode, 401);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('rejects an unsigned delivery', async () => {
    const payload = pushPayload();
    const response = await handleForgejoWebhook({
        body: JSON.stringify(payload),
        queryParameters: { c: [CONNECTION_ID] },
        headers: { 'X-Forgejo-Event': ['push'] }
    });
    assert.strictEqual(response.statusCode, 401);
});

await test('rejects a malformed JSON body that is correctly signed', async () => {
    const response = await handleForgejoWebhook(request('{not json'));
    assert.strictEqual(response.statusCode, 400);
});

await test('ignores an event type it does not handle', async () => {
    const response = await handleForgejoWebhook(request({ zen: 'hi' }, { event: 'issues' }));
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

// ---------------------------------------------------------------------------

group('Push events');

await test('submits a commit that names an issue', async () => {
    const response = await handleForgejoWebhook(request(pushPayload()));

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(harness.jiraRequests.length, 1);

    const body = submittedBody();
    assert.strictEqual(body.preventTransitions, true, 'commits must not transition issues');
    assert.strictEqual(body.providerMetadata.product, 'Forgejo');

    const commit = body.repositories[0].commits[0];
    assert.deepStrictEqual(commit.issueKeys, ['BHP-1']);
    assert.strictEqual(commit.fileCount, 2);
    assert.strictEqual(commit.displayId.length, 7);
    assert.strictEqual(commit.author.email, 'test@example.com');
});

await test('namespaces the repository id by connection', async () => {
    await handleForgejoWebhook(request(pushPayload()));
    // Two Forgejo instances both numbering their first repository 1 must not
    // collide into a single Jira repository entry.
    assert.strictEqual(submittedRepository().id, `${CONNECTION_ID}-42`);
    assert.strictEqual(submittedRepository().name, 'acme/test-repo');
});

await test('drops commits that name no issue, keeping those that do', async () => {
    await handleForgejoWebhook(
        request(pushPayload({ messages: ['no key here', 'BHP-2 real work', 'chore: tidy'] }))
    );

    const commits = submittedRepository().commits;
    assert.strictEqual(commits.length, 1);
    assert.deepStrictEqual(commits[0].issueKeys, ['BHP-2']);
});

await test('calls Jira not at all when a push names no issue', async () => {
    const response = await handleForgejoWebhook(request(pushPayload({ messages: ['tidy up'] })));

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

/**
 * Forgejo caps a push payload's `commits` at PAYLOAD_COMMIT_LIMIT (15 by default)
 * while still reporting the real size in `total_commits`. Merging a long branch
 * therefore delivers a handful of commits and drops the rest on the floor.
 */
await test('queues the commits a truncated push left out', async () => {
    await handleForgejoWebhook(
        request({
            ...pushPayload({ messages: ['BHP-1 add widget'] }),
            total_commits: 40,
            before: 'a'.repeat(40),
            after: 'b'.repeat(40)
        })
    );

    assert.strictEqual(harness.queued.length, 1);

    const { body } = harness.queued[0];
    assert.deepStrictEqual(body.range, { before: 'a'.repeat(40), after: 'b'.repeat(40) });
    assert.strictEqual(body.repoId, '42');
});

await test('queues nothing when the push payload was complete', async () => {
    await handleForgejoWebhook(
        request({ ...pushPayload(), total_commits: 1, before: 'a'.repeat(40), after: 'b'.repeat(40) })
    );

    assert.strictEqual(harness.queued.length, 0);
});

await test('queues nothing for a newly created branch, which has no before', async () => {
    // Git sends an all-zero `before` for a branch that did not exist, and there is
    // no range to compare against.
    await handleForgejoWebhook(
        request({
            ...pushPayload(),
            total_commits: 40,
            before: '0'.repeat(40),
            after: 'b'.repeat(40)
        })
    );

    assert.strictEqual(harness.queued.length, 0);
});

await test('still submits the delivered commits when queueing the remainder fails', async () => {
    harness.queuePushError = 'queue unavailable';

    const response = await handleForgejoWebhook(
        request({
            ...pushPayload({ messages: ['BHP-1 add widget'] }),
            total_commits: 40,
            before: 'a'.repeat(40),
            after: 'b'.repeat(40)
        })
    );

    assert.strictEqual(response.statusCode, 202, 'the commits that did arrive still count');
});

await test('imports a queued commit range', async () => {
    await storage.saveRepository({
        connectionId: CONNECTION_ID,
        repoId: '42',
        fullName: 'acme/test-repo',
        owner: 'acme',
        name: 'test-repo',
        htmlUrl: 'https://forgejo.example.com/acme/test-repo'
    });

    harness.respondWith({
        commits: [
            {
                sha: 'c'.repeat(40),
                commit: {
                    message: 'BHP-9 from the truncated part of the push',
                    author: { name: 'Test User', email: 'test@example.com' },
                    committer: { date: '2026-08-09T10:00:00Z' }
                },
                html_url: 'https://forgejo.example.com/acme/test-repo/commit/ccc'
            }
        ]
    });

    await backfillHandler({
        body: {
            connectionId: CONNECTION_ID,
            repoId: '42',
            range: { before: 'a'.repeat(40), after: 'b'.repeat(40) }
        }
    });

    const commits = submittedRepository().commits;
    assert.strictEqual(commits.length, 1);
    assert.deepStrictEqual(commits[0].issueKeys, ['BHP-9']);
});

await test('attributes each commit only to the keys in its own message', async () => {
    await handleForgejoWebhook(
        request(pushPayload({ messages: ['ABC-1 first', 'DEF-2 second'] }))
    );

    const commits = submittedRepository().commits;
    assert.deepStrictEqual(commits[0].issueKeys, ['ABC-1']);
    assert.deepStrictEqual(commits[1].issueKeys, ['DEF-2']);
});

await test('falls back to sniffing a push when the event header is absent', async () => {
    const payload = pushPayload();
    const body = JSON.stringify(payload);

    const response = await handleForgejoWebhook({
        body,
        queryParameters: { c: [CONNECTION_ID] },
        headers: { 'x-forgejo-signature': [sign(body)] }
    });

    assert.strictEqual(response.statusCode, 202);
});

await test('splits a push into batches under Jira\'s 400-entity limit', async () => {
    const messages = Array.from({ length: 900 }, (_, index) => `ABC-${index + 1} commit`);
    await handleForgejoWebhook(request(pushPayload({ messages })));

    assert.strictEqual(harness.jiraRequests.length, 3, 'expected 400 + 400 + 100');
    assert.strictEqual(submittedRepository(0).commits.length, 400);
    assert.strictEqual(submittedRepository(2).commits.length, 100);
    // Every batch repeats the repository wrapper - it is not a create-once record.
    assert.strictEqual(submittedRepository(2).id, `${CONNECTION_ID}-42`);
});

// ---------------------------------------------------------------------------

group('Branch events');

await test('submits a branch whose name contains an issue key', async () => {
    const response = await handleForgejoWebhook(
        request(
            {
                ref: 'KAN-1-new-feature',
                ref_type: 'branch',
                sha: 'b'.repeat(40),
                repository,
                sender: { login: 'tester', full_name: 'Test User', email: 'test@example.com' }
            },
            { event: 'create' }
        )
    );

    assert.strictEqual(response.statusCode, 202);

    const branch = submittedRepository().branches[0];
    assert.strictEqual(branch.id, 'KAN-1-new-feature');
    assert.deepStrictEqual(branch.issueKeys, ['KAN-1']);
    assert.ok(branch.url.endsWith('/src/branch/KAN-1-new-feature'));
    // Jira rejects a branch with no lastCommit, whatever the published schema says.
    assert.ok(branch.lastCommit, 'branch must carry a lastCommit');
    assert.strictEqual(branch.lastCommit.hash, 'b'.repeat(40));
    assert.deepStrictEqual(branch.lastCommit.issueKeys, ['KAN-1']);
});

await test('skips a branch creation that carries no head SHA', async () => {
    const response = await handleForgejoWebhook(
        request({ ref: 'KAN-1-feature', ref_type: 'branch', repository }, { event: 'create' })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('ignores tag creation, which has no branch semantics', async () => {
    const response = await handleForgejoWebhook(
        request({ ref: 'KAN-1-v1.0', ref_type: 'tag', sha: 'c'.repeat(40), repository }, { event: 'create' })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('deletes a branch from Jira when Forgejo reports its removal', async () => {
    const response = await handleForgejoWebhook(
        request({ ref: 'KAN-1-new-feature', ref_type: 'branch', repository }, { event: 'delete' })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 1);
    assert.strictEqual(harness.jiraRequests[0].method, 'DELETE');
    assert.ok(harness.jiraRequests[0].path.includes(`${CONNECTION_ID}-42/branch/KAN-1-new-feature`));
});

await test('does not call Jira when an unlinked branch is deleted', async () => {
    await handleForgejoWebhook(
        request({ ref: 'scratch-work', ref_type: 'branch', repository }, { event: 'delete' })
    );

    assert.strictEqual(harness.jiraRequests.length, 0);
});

// Forgejo sends `refs/heads/KAN-1` from the create webhook but plain `KAN-1` from
// the REST branch listing. Storing both forms gives Jira two entities for one
// branch, and neither carries the name a pull request reports as its source.
await test('reduces a fully qualified ref to the branch name', async () => {
    const response = await handleForgejoWebhook(
        request(
            {
                ref: 'refs/heads/KAN-1-new-feature',
                ref_type: 'branch',
                sha: 'b'.repeat(40),
                repository,
                sender: { login: 'tester' }
            },
            { event: 'create' }
        )
    );

    assert.strictEqual(response.statusCode, 202);

    const branch = submittedRepository().branches[0];
    assert.strictEqual(branch.name, 'KAN-1-new-feature');
    assert.strictEqual(branch.id, 'KAN-1-new-feature');
    assert.ok(branch.url.endsWith('/src/branch/KAN-1-new-feature'));
});

// Jira validates branch ids against [A-Za-z0-9\-._~] and rejects the whole batch
// with devInformation.repository.branch.id.invalid otherwise, but `feature/KAN-1`
// is an entirely ordinary branch name.
await test('sanitises a branch id while keeping the real name', async () => {
    await handleForgejoWebhook(
        request(
            {
                ref: 'refs/heads/feature/KAN-1',
                ref_type: 'branch',
                sha: 'c'.repeat(40),
                repository,
                sender: { login: 'tester' }
            },
            { event: 'create' }
        )
    );

    const branch = submittedRepository().branches[0];
    assert.match(branch.id, /^[A-Za-z0-9\-._~]+$/);
    // The name keeps the slash: it is what Jira matches a pull request's
    // sourceBranch against, and what a human reads.
    assert.strictEqual(branch.name, 'feature/KAN-1');
});

// A delete that derives its id differently from the create addresses something
// that was never stored, and the stale branch outlives its deletion.
await test('deletes a branch under the same id it was stored with', async () => {
    await handleForgejoWebhook(
        request({ ref: 'refs/heads/feature/KAN-1', ref_type: 'branch', repository }, { event: 'delete' })
    );

    assert.strictEqual(harness.jiraRequests.length, 1);
    assert.strictEqual(harness.jiraRequests[0].method, 'DELETE');
    assert.ok(
        harness.jiraRequests[0].path.includes(`${CONNECTION_ID}-42/branch/feature-KAN-1`),
        `unexpected delete path: ${harness.jiraRequests[0].path}`
    );
});

// Fills the "Action" column of the development panel's branch list.
await test('offers a create-pull-request URL when the default branch is known', async () => {
    await handleForgejoWebhook(
        request(
            {
                ref: 'refs/heads/KAN-1-new-feature',
                ref_type: 'branch',
                sha: 'd'.repeat(40),
                repository: { ...repository, default_branch: 'main' },
                sender: { login: 'tester' }
            },
            { event: 'create' }
        )
    );

    const branch = submittedRepository().branches[0];
    assert.strictEqual(
        branch.createPullRequestUrl,
        'https://forgejo.example.com/acme/test-repo/compare/main...KAN-1-new-feature'
    );
});

// Without a base there is no valid compare URL, and a broken action is worse than
// no action at all.
await test('omits the create-pull-request URL when the default branch is unknown', async () => {
    await handleForgejoWebhook(
        request(
            {
                ref: 'refs/heads/KAN-1-new-feature',
                ref_type: 'branch',
                sha: 'e'.repeat(40),
                repository,
                sender: { login: 'tester' }
            },
            { event: 'create' }
        )
    );

    assert.strictEqual(submittedRepository().branches[0].createPullRequestUrl, undefined);
});

// ---------------------------------------------------------------------------

group('Pull request events');

function pullRequestPayload(overrides = {}) {
    return {
        action: 'opened',
        repository,
        pull_request: {
            number: 7,
            title: 'ABC-5 add the thing',
            html_url: 'https://forgejo.example.com/acme/test-repo/pulls/7',
            state: 'open',
            user: { login: 'tester', full_name: 'Test User', email: 'test@example.com' },
            // Forgejo sends the full repository object on both sides, which is
            // where the branch URLs Jira links against come from.
            head: { ref: 'ABC-5-add-the-thing', repo: repository },
            base: { ref: 'main', repo: repository },
            comments: 3,
            updated_at: '2026-08-09T12:00:00Z',
            ...overrides
        }
    };
}

await test('submits a pull request', async () => {
    const response = await handleForgejoWebhook(
        request(pullRequestPayload(), { event: 'pull_request' })
    );

    assert.strictEqual(response.statusCode, 202);

    const pr = submittedRepository().pullRequests[0];
    assert.strictEqual(pr.id, '7');
    assert.strictEqual(pr.displayId, '#7');
    assert.strictEqual(pr.status, 'OPEN');
    assert.strictEqual(pr.sourceBranch, 'ABC-5-add-the-thing');
    assert.strictEqual(pr.destinationBranch, 'main');
    assert.strictEqual(pr.commentCount, 3);
    assert.deepStrictEqual(pr.issueKeys, ['ABC-5']);
});

// Jira fills the "Pull request" column of an issue's branch list by matching a
// pull request's sourceBranchUrl against a branch entity's url. Identical names
// are not enough - without the URL the column stays empty even though both
// entities are present.
await test('links a pull request to its branch by URL', async () => {
    await handleForgejoWebhook(
        request(
            {
                ref: 'refs/heads/ABC-5-add-the-thing',
                ref_type: 'branch',
                sha: 'f'.repeat(40),
                repository,
                sender: { login: 'tester' }
            },
            { event: 'create' }
        )
    );
    const branch = submittedRepository().branches[0];

    harness.jiraRequests.length = 0;

    await handleForgejoWebhook(request(pullRequestPayload(), { event: 'pull_request' }));
    const pr = submittedRepository().pullRequests[0];

    assert.strictEqual(
        pr.sourceBranchUrl,
        branch.url,
        'the pull request must address the branch by exactly the URL the branch was stored with'
    );
    assert.strictEqual(
        pr.destinationBranchUrl,
        'https://forgejo.example.com/acme/test-repo/src/branch/main'
    );
});

// A pull request opened from a fork has its source branch in the fork, so the URL
// must follow the head repository rather than assume the base.
await test('points the source branch URL at the fork it lives in', async () => {
    await handleForgejoWebhook(
        request(
            pullRequestPayload({
                head: {
                    ref: 'ABC-5-add-the-thing',
                    repo: { html_url: 'https://forgejo.example.com/contributor/test-repo' }
                }
            }),
            { event: 'pull_request' }
        )
    );

    const pr = submittedRepository().pullRequests[0];
    assert.strictEqual(
        pr.sourceBranchUrl,
        'https://forgejo.example.com/contributor/test-repo/src/branch/ABC-5-add-the-thing'
    );
});

await test('reports a merged pull request as MERGED, not DECLINED', () => {
    // Forgejo sets state to "closed" on merge, so the merged flag has to win.
    assert.strictEqual(devinfo.mapPullRequestStatus({ state: 'closed', merged: true }), 'MERGED');
    assert.strictEqual(devinfo.mapPullRequestStatus({ state: 'closed' }), 'DECLINED');
    assert.strictEqual(devinfo.mapPullRequestStatus({ state: 'open' }), 'OPEN');
    assert.strictEqual(devinfo.mapPullRequestStatus({ state: 'open', draft: true }), 'DRAFT');
    assert.strictEqual(devinfo.mapPullRequestStatus({}), 'UNKNOWN');
});

await test('takes the issue key from the source branch when the title has none', async () => {
    await handleForgejoWebhook(
        request(pullRequestPayload({ title: 'Tidy up the imports' }), { event: 'pull_request' })
    );

    assert.deepStrictEqual(submittedRepository().pullRequests[0].issueKeys, ['ABC-5']);
});

await test('handles review events, which also carry the pull request', async () => {
    const response = await handleForgejoWebhook(
        request(pullRequestPayload({ state: 'open' }), { event: 'pull_request_review_approved' })
    );

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(submittedRepository().pullRequests[0].id, '7');
});

await test('maps requested reviewers', async () => {
    await handleForgejoWebhook(
        request(
            pullRequestPayload({
                requested_reviewers: [{ login: 'reviewer', full_name: 'A Reviewer', email: 'r@example.com' }]
            }),
            { event: 'pull_request' }
        )
    );

    const reviewers = submittedRepository().pullRequests[0].reviewers;
    assert.strictEqual(reviewers.length, 1);
    assert.strictEqual(reviewers[0].name, 'A Reviewer');
    assert.strictEqual(reviewers[0].approvalStatus, 'UNAPPROVED');
});

/**
 * Approval state lives only on the reviews endpoint. Forgejo drops a reviewer
 * from `requested_reviewers` the moment they act, so a pull request object alone
 * cannot say who approved - it cannot even say they were a reviewer.
 */
const reviewer = (login, full_name) => ({ login, full_name, email: `${login}@example.com` });

await test('marks a reviewer approved from the reviews endpoint', async () => {
    harness.respondWith([{ state: 'APPROVED', user: reviewer('reviewer', 'A Reviewer') }]);

    await handleForgejoWebhook(
        // Deliberately absent from requested_reviewers, which is what Forgejo does
        // once the review lands.
        request(pullRequestPayload({ requested_reviewers: [] }), { event: 'pull_request' })
    );

    const reviewers = submittedRepository().pullRequests[0].reviewers;
    assert.strictEqual(reviewers.length, 1);
    assert.strictEqual(reviewers[0].name, 'A Reviewer');
    assert.strictEqual(reviewers[0].approvalStatus, 'APPROVED');
});

await test('lists a reviewer once when they were requested and then reviewed', async () => {
    harness.respondWith([{ state: 'APPROVED', user: reviewer('reviewer', 'A Reviewer') }]);

    await handleForgejoWebhook(
        request(pullRequestPayload({ requested_reviewers: [reviewer('reviewer', 'A Reviewer')] }), {
            event: 'pull_request'
        })
    );

    const reviewers = submittedRepository().pullRequests[0].reviewers;
    assert.strictEqual(reviewers.length, 1, 'the same person must not appear twice');
    assert.strictEqual(reviewers[0].approvalStatus, 'APPROVED');
});

await test('takes a reviewer\'s most recent verdict, not their first', async () => {
    // Approved, then changed their mind. Still reading as approved would tell Jira
    // the pull request is ready when it is not.
    harness.respondWith([
        { state: 'APPROVED', user: reviewer('reviewer', 'A Reviewer') },
        { state: 'REQUEST_CHANGES', user: reviewer('reviewer', 'A Reviewer') }
    ]);

    await handleForgejoWebhook(
        request(pullRequestPayload({ requested_reviewers: [] }), { event: 'pull_request' })
    );

    assert.strictEqual(
        submittedRepository().pullRequests[0].reviewers[0].approvalStatus,
        'UNAPPROVED'
    );
});

await test('does not let a later comment revoke an approval', async () => {
    harness.respondWith([
        { state: 'APPROVED', user: reviewer('reviewer', 'A Reviewer') },
        { state: 'COMMENT', user: reviewer('reviewer', 'A Reviewer') }
    ]);

    await handleForgejoWebhook(
        request(pullRequestPayload({ requested_reviewers: [] }), { event: 'pull_request' })
    );

    assert.strictEqual(
        submittedRepository().pullRequests[0].reviewers[0].approvalStatus,
        'APPROVED'
    );
});

await test('ignores an unsubmitted (pending) review', async () => {
    harness.respondWith([{ state: 'PENDING', user: reviewer('drafter', 'Draft Reviewer') }]);

    await handleForgejoWebhook(
        request(pullRequestPayload({ requested_reviewers: [] }), { event: 'pull_request' })
    );

    assert.deepStrictEqual(submittedRepository().pullRequests[0].reviewers, []);
});

await test('still submits the pull request when reviews cannot be read', async () => {
    // An unreachable Forgejo should cost the approval badges, not the pull request.
    harness.respondWith({ message: 'boom' }, { status: 500 });

    const response = await handleForgejoWebhook(
        request(pullRequestPayload({ requested_reviewers: [reviewer('reviewer', 'A Reviewer')] }), {
            event: 'pull_request'
        })
    );

    assert.strictEqual(response.statusCode, 202);

    const reviewers = submittedRepository().pullRequests[0].reviewers;
    assert.strictEqual(reviewers[0].approvalStatus, 'UNAPPROVED');
});

await test('does not read reviews for a pull request that names no issue', async () => {
    await handleForgejoWebhook(
        request(pullRequestPayload({ title: 'tidy', head: { ref: 'tidy-up' } }), {
            event: 'pull_request'
        })
    );

    assert.strictEqual(harness.fetches.length, 0, 'irrelevant events must cost no API call');
});

await test('ignores a pull request that names no issue anywhere', async () => {
    const response = await handleForgejoWebhook(
        request(pullRequestPayload({ title: 'tidy', head: { ref: 'tidy-up' } }), {
            event: 'pull_request'
        })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

// ---------------------------------------------------------------------------

group('Repository events');

await test('removes a repository from Jira when it is deleted in Forgejo', async () => {
    const response = await handleForgejoWebhook(
        request({ action: 'deleted', repository }, { event: 'repository' })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests[0].method, 'DELETE');
    assert.ok(harness.jiraRequests[0].path.endsWith(`/repository/${CONNECTION_ID}-42`));
});

await test('ignores repository creation', async () => {
    await handleForgejoWebhook(request({ action: 'created', repository }, { event: 'repository' }));
    assert.strictEqual(harness.jiraRequests.length, 0);
});

// ---------------------------------------------------------------------------

group('REST API mappers used by backfill');

await test('maps a commit from the REST API shape', () => {
    const commit = devinfo.mapApiCommit({
        sha: 'd'.repeat(40),
        html_url: 'https://forgejo.example.com/acme/test-repo/commit/dddd',
        commit: {
            message: 'ABC-3 rework the parser',
            author: { name: 'Test User', email: 'test@example.com', date: '2026-08-01T00:00:00Z' }
        },
        author: { login: 'testuser' }
    });

    assert.deepStrictEqual(commit.issueKeys, ['ABC-3']);
    assert.strictEqual(commit.authorTimestamp, '2026-08-01T00:00:00Z');
    assert.strictEqual(commit.author.username, 'testuser');
    assert.strictEqual(commit.displayId, 'dddddd'.substring(0, 7).padEnd(7, 'd'));
});

await test('drops a REST commit with no issue key', () => {
    assert.strictEqual(
        devinfo.mapApiCommit({ sha: 'e'.repeat(40), commit: { message: 'tidy' } }),
        undefined
    );
});

await test('maps a branch from the REST API shape', () => {
    const branch = devinfo.mapApiBranch(
        {
            name: 'ABC-4-feature',
            commit: {
                id: 'f'.repeat(40),
                message: 'wip',
                timestamp: '2026-08-02T00:00:00Z',
                author: { name: 'Test User', email: 'test@example.com' }
            }
        },
        repository.html_url
    );

    assert.deepStrictEqual(branch.issueKeys, ['ABC-4']);
    // A branch head very often has no key in its own message; it inherits the
    // branch's keys rather than being dropped.
    assert.deepStrictEqual(branch.lastCommit.issueKeys, ['ABC-4']);
    assert.strictEqual(branch.lastCommit.message, 'wip');
});

// ---------------------------------------------------------------------------

group('Backfill');

async function seedRepository() {
    await storage.saveRepository({
        connectionId: CONNECTION_ID,
        repoId: '42',
        fullName: 'acme/test-repo',
        owner: 'acme',
        name: 'test-repo',
        htmlUrl: repository.html_url,
        hookId: 1,
        addedAt: 1
    });
}

/**
 * Invoke the consumer the way Forge does.
 *
 * The `consumer` module names the function directly, so Forge delivers the async
 * event itself and the pushed payload arrives as `body`. It must NOT be wrapped
 * in a resolver: @forge/events publishes with the `forge/app-event-2` schema,
 * which rejects the `resolver:` form at publish time with
 * "Schema version 2 does not support resolver".
 */
async function runBackfillPage(payload) {
    return backfillHandler({ body: payload, queueName: 'forgejo-backfill', jobId: 'job-test' });
}

await test('queues the first page when a backfill starts', async () => {
    await seedRepository();

    const { jobId } = await startBackfill(CONNECTION_ID, '42');

    assert.ok(jobId);
    assert.strictEqual(harness.queued.length, 1);
    assert.deepStrictEqual(harness.queued[0].body, {
        connectionId: CONNECTION_ID,
        repoId: '42',
        phase: 'branches',
        page: 1
    });

    const repo = await storage.getRepository(CONNECTION_ID, '42');
    assert.strictEqual(repo.backfill.status, 'queued');
});

await test('marks the repository failed when the queue rejects the push', async () => {
    await seedRepository();
    harness.queuePushError = 'Schema version 2 does not support resolver';

    await assert.rejects(() => startBackfill(CONNECTION_ID, '42'));

    // Progress is recorded before the push so the admin sees work start. If the
    // push then fails and that record is not corrected, the repository reads
    // "queued" forever and the admin page polls for a change that cannot come.
    const repo = await storage.getRepository(CONNECTION_ID, '42');
    assert.strictEqual(repo.backfill.status, 'failed');
    assert.match(repo.backfill.error, /Schema version 2/);
    assert.ok(repo.backfill.finishedAt);
});

await test('advances to the next page while Forgejo reports more', async () => {
    await seedRepository();

    // A full page of 50 means there may be more, so the next page is queued.
    harness.respondWith(
        Array.from({ length: 50 }, (_, index) => ({
            name: `ABC-${index + 1}-branch`,
            commit: { id: String(index).padStart(40, '0'), message: 'wip' }
        })),
        { headers: { 'x-total-count': '120' } }
    );

    await runBackfillPage({ connectionId: CONNECTION_ID, repoId: '42', phase: 'branches', page: 1 });

    assert.strictEqual(harness.queued.length, 1);
    assert.deepStrictEqual(harness.queued[0].body.phase, 'branches');
    assert.deepStrictEqual(harness.queued[0].body.page, 2);

    const repo = await storage.getRepository(CONNECTION_ID, '42');
    assert.strictEqual(repo.backfill.counts.branches, 50);
    assert.strictEqual(repo.backfill.status, 'running');
});

await test('moves to the next phase when a phase runs out', async () => {
    await seedRepository();

    harness.respondWith([], { headers: { 'x-total-count': '0' } });

    await runBackfillPage({ connectionId: CONNECTION_ID, repoId: '42', phase: 'branches', page: 1 });

    assert.strictEqual(harness.queued.length, 1);
    assert.strictEqual(harness.queued[0].body.phase, 'pullRequests');
    assert.strictEqual(harness.queued[0].body.page, 1);
});

await test('finishes after the last phase', async () => {
    await seedRepository();

    harness.respondWith([], { headers: { 'x-total-count': '0' } });

    await runBackfillPage({ connectionId: CONNECTION_ID, repoId: '42', phase: 'commits', page: 1 });

    assert.strictEqual(harness.queued.length, 0, 'nothing more should be queued');

    const repo = await storage.getRepository(CONNECTION_ID, '42');
    assert.strictEqual(repo.backfill.status, 'complete');
    assert.ok(repo.backfill.finishedAt);
});

await test('asks for a retry when Forgejo fails', async () => {
    await seedRepository();

    harness.respondWith('upstream exploded', { status: 500 });

    const result = await runBackfillPage({
        connectionId: CONNECTION_ID,
        repoId: '42',
        phase: 'commits',
        page: 1
    });

    // A transient Forgejo failure must not silently end the import.
    assert.ok(result, 'expected an InvocationError asking Forge to retry');
    assert.strictEqual(result._retry, true);
    assert.strictEqual(result.retryOptions.retryReason, 'FUNCTION_RETRY_REQUEST');
    assert.strictEqual(harness.queued.length, 0);

    const repo = await storage.getRepository(CONNECTION_ID, '42');
    assert.ok(repo.backfill.error, 'the failure should be visible to the admin');
});

await test('stops quietly when the repository was disconnected mid-run', async () => {
    const result = await runBackfillPage({
        connectionId: CONNECTION_ID,
        repoId: '999',
        phase: 'commits',
        page: 1
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(harness.fetches.length, 0);
});

await test('sends the access token on Forgejo requests', async () => {
    await seedRepository();
    harness.respondWith([]);

    await runBackfillPage({ connectionId: CONNECTION_ID, repoId: '42', phase: 'commits', page: 1 });

    const call = harness.fetches[0];
    assert.ok(call.url.startsWith('https://forgejo.example.com/api/v1/repos/acme/test-repo/commits'));
    assert.strictEqual(call.options.headers.Authorization, 'Bearer access-token');
    // Asking for full file lists on every commit turns a backfill into a very slow
    // one, and Jira only needs a count.
    assert.ok(call.url.includes('stat=false'));
});

// ---------------------------------------------------------------------------

group('Workflow run webhooks');

// Shaped after a real Forgejo delivery: the run object is nested under `run`,
// `action` is the status it moved to, and the repository is nested too.
function workflowRunPayload(overrides = {}, runOverrides = {}) {
    return {
        action: 'success',
        prior_status: 'running',
        run: {
            id: 149,
            index_in_repo: 104,
            title: "Merge pull request 'KAN-1: Composer Update' (#75) from KAN-1 into main",
            workflow_id: 'deploy.yml',
            prettyref: 'main',
            status: 'success',
            event: 'push',
            html_url: 'https://forgejo.example.com/acme/test-repo/actions/runs/104',
            updated: '2026-08-14T15:58:48Z',
            repository,
            ...runOverrides
        },
        ...overrides
    };
}

await test('reports a finished workflow run as a build', async () => {
    const response = await handleForgejoWebhook(
        request(workflowRunPayload(), { event: 'action_run_success' })
    );

    assert.strictEqual(response.statusCode, 202);

    const build = JSON.parse(harness.jiraRequests[0].options.body).builds[0];
    assert.ok(harness.jiraRequests[0].path.includes('/rest/builds/0.1/bulk'));
    assert.strictEqual(build.state, 'successful');
    // index_in_repo is Forgejo's per-repository run counter, which is what Jira
    // needs to order builds within a pipeline.
    assert.strictEqual(build.buildNumber, 104);
    // Scoped by connection and repository: Jira keys builds on pipeline and
    // build number alone, and Forgejo's build number is only unique per repo.
    assert.strictEqual(build.pipelineId, `${CONNECTION_ID}-42-deploy.yml`);
    assert.strictEqual(build.displayName, 'test-repo/deploy.yml');
    assert.deepStrictEqual(build.issueKeys, ['KAN-1']);
});

// A workflow that reports its own deployment must not also file a build: the
// issue would show a deployment and an unrelated build for the same run, and
// Jira cannot relate them.
await test('does not report a build for an excluded workflow', async () => {
    await storage.saveConnection({
        id: CONNECTION_ID,
        name: 'Test Forgejo',
        instanceUrl: 'https://forgejo.example.com',
        clientId: 'client-id',
        createdAt: 1,
        buildIgnoredWorkflows: ['deploy.yml']
    });

    const response = await handleForgejoWebhook(
        request(workflowRunPayload(), { event: 'action_run_success' })
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('still reports builds for workflows that are not excluded', async () => {
    await storage.saveConnection({
        id: CONNECTION_ID,
        name: 'Test Forgejo',
        instanceUrl: 'https://forgejo.example.com',
        clientId: 'client-id',
        createdAt: 1,
        // Named with different case and spacing than the run carries, because a
        // customer typing the name back in should not have to match it exactly.
        buildIgnoredWorkflows: [' Deploy.YML ']
    });

    await handleForgejoWebhook(
        request(
            workflowRunPayload({}, { workflow_id: 'pest-browser-tests.yml' }),
            { event: 'action_run_success' }
        )
    );
    assert.strictEqual(harness.jiraRequests.length, 1);

    harness.jiraRequests.length = 0;

    // ...and the case-insensitive match still excludes the deploy workflow.
    await handleForgejoWebhook(request(workflowRunPayload(), { event: 'action_run_success' }));
    assert.strictEqual(harness.jiraRequests.length, 0);
});

// Jira keys a build on pipelineId and buildNumber alone - the builds API has no
// repository field - and Forgejo's build number restarts at 1 in every
// repository. Two repositories that both have ci.yml would overwrite each other
// on every run.
await test('does not collide across repositories running the same workflow', async () => {
    const inRepo = (id, name) =>
        workflowRunPayload({}, {
            workflow_id: 'ci.yml',
            index_in_repo: 5,
            repository: { ...repository, id, name }
        });

    await handleForgejoWebhook(request(inRepo(17, 'repo-a'), { event: 'action_run_success' }));
    const a = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    harness.jiraRequests.length = 0;

    await handleForgejoWebhook(request(inRepo(42, 'repo-b'), { event: 'action_run_success' }));
    const b = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    assert.strictEqual(a.buildNumber, b.buildNumber);
    assert.notStrictEqual(a.pipelineId, b.pipelineId);
    assert.notStrictEqual(a.displayName, b.displayName);
});

// Jira's build panel groups rows by displayName. Naming a build after its commit
// subject - which changes every run - files each build as its own pipeline, so
// the panel grows a row per push instead of one row that updates.
await test('names a build after its pipeline, not its commit subject', async () => {
    await handleForgejoWebhook(request(workflowRunPayload(), { event: 'action_run_success' }));
    const first = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    harness.jiraRequests.length = 0;

    await handleForgejoWebhook(
        request(
            workflowRunPayload({}, { title: 'KAN-1 a different commit', index_in_repo: 105 }),
            { event: 'action_run_success' }
        )
    );
    const second = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    assert.strictEqual(first.displayName, 'test-repo/deploy.yml');
    assert.strictEqual(second.displayName, first.displayName);
    assert.notStrictEqual(second.buildNumber, first.buildNumber);
});

// Forgejo sends a delivery per transition, so a run reports in progress and then
// its result. Both must land on the same pipeline and build number or Jira files
// them as two unrelated builds.
await test('reports a running workflow as in progress under the same build', async () => {
    await handleForgejoWebhook(
        request(
            workflowRunPayload({ action: 'running', prior_status: 'waiting' }, { status: 'running' }),
            { event: 'action_run_success' }
        )
    );
    const started = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    harness.jiraRequests.length = 0;

    await handleForgejoWebhook(request(workflowRunPayload(), { event: 'action_run_success' }));
    const finished = JSON.parse(harness.jiraRequests[0].options.body).builds[0];

    assert.strictEqual(started.state, 'in_progress');
    assert.strictEqual(finished.state, 'successful');
    assert.strictEqual(started.pipelineId, finished.pipelineId);
    assert.strictEqual(started.buildNumber, finished.buildNumber);
});

await test('maps a failed run to failed', async () => {
    await handleForgejoWebhook(
        request(workflowRunPayload({ action: 'failure' }), { event: 'action_run_failure' })
    );

    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].state,
        'failed'
    );
});

// action_run_recover is a run that passed after the previous one failed. The
// event name describes the transition, not a third outcome, so it is a success.
await test('maps a recovered run to successful', async () => {
    await handleForgejoWebhook(
        request(workflowRunPayload({ action: 'recover' }), { event: 'action_run_recover' })
    );

    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].state,
        'successful'
    );
});

// Forgejo delivers the same body under GitHub-compatible headers, and GitHub
// calls this event workflow_run. Accepting both costs nothing.
await test('accepts the GitHub name for the same event', async () => {
    const response = await handleForgejoWebhook(
        request(workflowRunPayload(), { event: 'workflow_run' })
    );

    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].state,
        'successful'
    );
});

// A skipped run proves nothing about the code. Reporting it green would put a
// passing build on an issue that was never built.
await test('does not report a skipped run as successful', async () => {
    await handleForgejoWebhook(
        request(workflowRunPayload({ action: 'skipped' }), { event: 'action_run_success' })
    );

    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].state,
        'cancelled'
    );
});

await test('coerces an unrecognised run status rather than failing the batch', async () => {
    await handleForgejoWebhook(
        request(workflowRunPayload({ action: 'sideways' }), { event: 'action_run_success' })
    );

    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].state,
        'unknown'
    );
});

await test('takes the issue key from the branch when the run title has none', async () => {
    await handleForgejoWebhook(
        request(
            workflowRunPayload({}, { title: 'update deps', prettyref: 'KAN-9-bump' }),
            { event: 'action_run_success' }
        )
    );

    assert.deepStrictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).builds[0].issueKeys,
        ['KAN-9']
    );
});

await test('calls Jira not at all for a run that names no issue', async () => {
    const response = await handleForgejoWebhook(
        request(
            workflowRunPayload({}, { title: 'nightly maintenance', prettyref: 'main' }),
            { event: 'action_run_success' }
        )
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

// ---------------------------------------------------------------------------

group('Builds and deployments');

function ciRequest(payload, options = {}) {
    return request(payload, options);
}

await test('rejects an unsigned CI status request', async () => {
    const response = await handleCiStatus({
        body: JSON.stringify({ type: 'build' }),
        queryParameters: { c: [CONNECTION_ID] },
        headers: {}
    });

    assert.strictEqual(response.statusCode, 401);
});

await test('rejects a CI status for an unknown connection', async () => {
    const response = await handleCiStatus(
        ciRequest({ type: 'build' }, { connectionId: 'nosuchconnection' })
    );

    assert.strictEqual(response.statusCode, 404);
});

await test('submits a build', async () => {
    const response = await handleCiStatus(
        ciRequest({
            type: 'build',
            state: 'successful',
            buildNumber: 12,
            displayName: 'CI',
            url: 'https://forgejo.example.com/acme/test-repo/actions/runs/12',
            issueKeys: ['ABC-1']
        })
    );

    assert.strictEqual(response.statusCode, 202);

    const build = JSON.parse(harness.jiraRequests[0].options.body).builds[0];
    assert.strictEqual(build.state, 'successful');
    assert.strictEqual(build.buildNumber, 12);
    assert.deepStrictEqual(build.issueKeys, ['ABC-1']);
    assert.ok(harness.jiraRequests[0].path.includes('/rest/builds/0.1/bulk'));
});

await test('reads issue keys from the branch name when none are given', async () => {
    await handleCiStatus(
        ciRequest({
            type: 'build',
            state: 'failed',
            ref: 'ABC-9-hotfix',
            commitMessage: 'fix it',
            buildNumber: 3
        })
    );

    const build = JSON.parse(harness.jiraRequests[0].options.body).builds[0];
    assert.deepStrictEqual(build.issueKeys, ['ABC-9']);
    assert.strictEqual(build.state, 'failed');
});

await test('coerces an unknown build state rather than failing the batch', async () => {
    await handleCiStatus(
        ciRequest({ type: 'build', state: 'exploded', buildNumber: 1, issueKeys: ['ABC-1'] })
    );

    assert.strictEqual(JSON.parse(harness.jiraRequests[0].options.body).builds[0].state, 'unknown');
});

await test('submits a deployment', async () => {
    const response = await handleCiStatus(
        ciRequest({
            type: 'deployment',
            state: 'successful',
            environment: 'production',
            url: 'https://forgejo.example.com/acme/test-repo/actions/runs/13',
            issueKeys: ['ABC-2']
        })
    );

    assert.strictEqual(response.statusCode, 202);

    const deployment = JSON.parse(harness.jiraRequests[0].options.body).deployments[0];
    assert.strictEqual(deployment.environment.type, 'production');
    assert.strictEqual(deployment.state, 'successful');
    assert.ok(harness.jiraRequests[0].path.includes('/rest/deployments/0.1/bulk'));
});

await test('maps an unrecognised environment name to unmapped', async () => {
    await handleCiStatus(
        ciRequest({ type: 'deployment', state: 'successful', environment: 'qa-3', issueKeys: ['ABC-2'] })
    );

    const deployment = JSON.parse(harness.jiraRequests[0].options.body).deployments[0];
    assert.strictEqual(deployment.environment.type, 'unmapped');
    // The customer's own name is still shown, only the type is normalised.
    assert.strictEqual(deployment.environment.id, 'qa-3');
});

// Jira answers a scope failure with 401, and this trigger answers a bad HMAC
// with 401 too. Forwarding Jira's status verbatim made the two indistinguishable
// to the workflow that posted, and the author debugs their signing secret while
// the real fault is a missing scope in the app.
await test('does not disguise a Jira rejection as a rejection of the caller', async () => {
    harness.jiraResponse = {
        status: 401,
        body: '{"code":401,"message":"Unauthorized; scope does not match"}'
    };

    const response = await handleCiStatus(
        ciRequest({
            type: 'deployment',
            state: 'successful',
            environment: 'production',
            issueKeys: ['ABC-2']
        })
    );

    assert.notStrictEqual(response.statusCode, 401);
    assert.strictEqual(response.statusCode, 502);
    // Jira's own words survive, or there is nothing to debug from.
    assert.ok(response.body.includes('scope does not match'));
});

// rolled_back is a deployment state with no build equivalent. Validating a
// deployment against the build enum would record a rollback as "unknown" - the
// deployment lands in Jira saying nothing happened.
await test('keeps a rolled back deployment as rolled_back', async () => {
    await handleCiStatus(
        ciRequest({
            type: 'deployment',
            state: 'rolled_back',
            environment: 'production',
            issueKeys: ['ABC-2']
        })
    );

    assert.strictEqual(
        JSON.parse(harness.jiraRequests[0].options.body).deployments[0].state,
        'rolled_back'
    );
});

// Jira rejects a whole flag with "'details.environment.type' is not valid" when
// it is sent "unmapped", which the deployment normaliser produces for anything
// it does not recognise. A flag reported against "qa-3" would never appear.
await test('never sends a feature flag environment type Jira rejects', async () => {
    await handleCiStatus(
        ciRequest({
            type: 'featureFlag',
            key: 'checkout-v2',
            enabled: true,
            environment: 'qa-3',
            issueKeys: ['ABC-3']
        })
    );

    const flag = JSON.parse(harness.jiraRequests[0].options.body).flags[0];
    const allowed = ['development', 'testing', 'staging', 'production'];

    assert.ok(allowed.includes(flag.details[0].environment.type));
    // The customer's own name for it survives; only the type is normalised.
    assert.strictEqual(flag.details[0].environment.name, 'qa-3');
});

await test('submits a feature flag', async () => {
    const response = await handleCiStatus(
        ciRequest({
            type: 'featureFlag',
            key: 'checkout-v2',
            displayName: 'Checkout v2',
            enabled: true,
            rolloutPercentage: 25,
            environment: 'production',
            url: 'https://flags.example.com/checkout-v2',
            issueKeys: ['ABC-3']
        })
    );

    assert.strictEqual(response.statusCode, 202);
    assert.ok(harness.jiraRequests[0].path.includes('/rest/featureflags/0.1/bulk'));

    const flag = JSON.parse(harness.jiraRequests[0].options.body).flags[0];
    assert.strictEqual(flag.key, 'checkout-v2');
    assert.strictEqual(flag.displayName, 'Checkout v2');
    assert.deepStrictEqual(flag.issueKeys, ['ABC-3']);
    assert.strictEqual(flag.summary.status.enabled, true);
    assert.deepStrictEqual(flag.summary.status.rollout, { percentage: 25 });
    assert.strictEqual(flag.details[0].environment.type, 'production');
});

await test('omits rollout when no percentage was reported', async () => {
    // Jira validates the shape, so sending `percentage: undefined` fails the batch.
    await handleCiStatus(
        ciRequest({ type: 'featureFlag', key: 'simple-flag', enabled: false, issueKeys: ['ABC-3'] })
    );

    const flag = JSON.parse(harness.jiraRequests[0].options.body).flags[0];
    assert.strictEqual('rollout' in flag.summary.status, false);
    assert.strictEqual(flag.summary.status.defaultValue, 'false');
});

await test('rejects a feature flag with no key to identify it by', async () => {
    const response = await handleCiStatus(
        ciRequest({ type: 'featureFlag', displayName: 'Nameless', issueKeys: ['ABC-3'] })
    );

    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('skips CI status with no issue keys anywhere', async () => {
    const response = await handleCiStatus(ciRequest({ type: 'build', state: 'successful' }));

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(harness.jiraRequests.length, 0);
});

await test('rejects an unsupported CI status type', async () => {
    const response = await handleCiStatus(
        ciRequest({ type: 'smoke-signal', issueKeys: ['ABC-1'] })
    );

    assert.strictEqual(response.statusCode, 400);
});

// ---------------------------------------------------------------------------

group('Storage');

await test('lists connections without exposing secrets', async () => {
    const connections = await storage.listConnections();

    assert.strictEqual(connections.length, 1);
    assert.strictEqual(connections[0].id, CONNECTION_ID);
    assert.strictEqual(connections[0].clientSecret, undefined);
    assert.strictEqual(connections[0].webhookSecret, undefined);
});

await test('narrows a repository listing to one connection', async () => {
    await seedRepository();
    await storage.saveRepository({
        connectionId: 'otherconnection01',
        repoId: '1',
        fullName: 'other/repo',
        owner: 'other',
        name: 'repo',
        addedAt: 1
    });

    assert.strictEqual((await storage.listRepositories(CONNECTION_ID)).length, 1);
    assert.strictEqual((await storage.listRepositories()).length, 2);
});

await test('deleting a connection removes its repositories', async () => {
    await seedRepository();
    await storage.deleteConnection(CONNECTION_ID);

    assert.strictEqual(await storage.getConnection(CONNECTION_ID), undefined);
    assert.strictEqual(await storage.getConnectionSecrets(CONNECTION_ID), undefined);
    assert.strictEqual((await storage.listRepositories(CONNECTION_ID)).length, 0);
});

await test('consumes a pending OAuth state exactly once', async () => {
    await storage.savePendingState('state-1', { connectionId: CONNECTION_ID });

    assert.ok(await storage.consumePendingState('state-1'));
    // Replaying an intercepted callback URL must not work.
    assert.strictEqual(await storage.consumePendingState('state-1'), undefined);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    console.log(`\nFailing: ${failures.join(', ')}`);
    process.exit(1);
}
