import {
    branchEntityId,
    branchHeadCommit,
    deleteBranchEntity,
    deleteRepositoryEntity,
    devinfoRepositoryId,
    mapBranch,
    shortBranchName,
    mapPullRequest,
    mapPushCommit,
    repositoryEntity,
    submitDevInfo
} from './lib/devinfo.js';
import { startCommitRangeImport } from './backfill.js';
import { mapWorkflowRun, reportsBuilds, submitBuilds, workflowFile } from './lib/builds.js';
import { createClient } from './lib/forgejo-client.js';
import { extractIssueKeys } from './lib/issue-keys.js';
import { getConnection, getConnectionSecrets } from './lib/storage.js';
import { getRawBody, readEventType, readSignature, verifySignature } from './lib/verify-signature.js';

/**
 * Web trigger that receives Forgejo repository webhook deliveries.
 *
 * The trigger URL handed to the customer carries a `c` query parameter naming
 * the connection the delivery belongs to, for example:
 *
 *   https://<forge-trigger-host>/x1/abc...?c=9f3c1a2b4d5e6f708192a3b4
 *
 * That parameter selects which stored signing secret to verify against. It is
 * only a *selector* - it grants nothing on its own, because a delivery still has
 * to carry a valid HMAC computed with that connection's secret.
 *
 * Forge passes an object with `headers` (values are ARRAYS of strings), a
 * `body` string, and `queryParameters` (also arrays). That body is not quite the
 * bytes Forgejo sent - the platform strips line feeds out of it - so
 * `verifySignature` checks the signature against the delivered body *and* a
 * reconstruction of Forgejo's original pretty-printed rendering.
 */
export async function handleForgejoWebhook(request) {
    const connectionId = firstQueryValue(request.queryParameters, 'c');

    // Fail closed. Without a connection we cannot know which secret to verify
    // against, so there is no safe way to fall through to processing the payload.
    if (!connectionId) {
        console.warn('Rejected webhook delivery with no connection identifier.');
        return { statusCode: 400, body: 'Missing connection identifier' };
    }

    const secrets = await getConnectionSecrets(connectionId);
    if (!secrets?.webhookSecret) {
        console.warn(`Rejected webhook delivery for unknown connection ${connectionId}.`);
        return { statusCode: 404, body: 'Unknown connection' };
    }

    const rawBody = getRawBody(request);

    if (!verifySignature(rawBody, readSignature(request.headers), secrets.webhookSecret)) {
        console.warn(`Rejected webhook delivery for ${connectionId} with an invalid signature.`);
        return { statusCode: 401, body: 'Invalid signature' };
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (error) {
        console.error('Webhook body was not valid JSON:', error.message);
        return { statusCode: 400, body: 'Malformed JSON body' };
    }

    // Forgejo sends the event name in a header; some older deliveries omit it, so
    // fall back to sniffing the payload for a push.
    const eventType =
        readEventType(request.headers) || (Array.isArray(payload.commits) ? 'push' : undefined);

    return routeEvent(connectionId, eventType, payload);
}

/**
 * Dispatch a verified delivery to the right handler.
 *
 * Split from the entry point so tests can drive event handling without having to
 * reproduce Forge's request envelope.
 */
async function routeEvent(connectionId, eventType, payload) {
    // Every review, sync, label and assignment event carries the full pull request
    // object, so they all resolve to the same "re-map this pull request" work.
    // Forgejo names an Actions run event after its outcome - action_run_success,
    // action_run_failure, action_run_recover - rather than sending one
    // `workflow_run` event with the outcome in the body. The body is the same
    // shape in every case and carries the outcome in `action`, so they collapse to
    // one handler. GitHub's `workflow_run` name is accepted too, because the
    // payload is delivered under GitHub-compatible headers as well.
    const normalisedEvent = eventType?.startsWith('pull_request')
        ? 'pull_request'
        : eventType?.startsWith('action_run')
          ? 'workflow_run'
          : eventType;

    switch (normalisedEvent) {
        case 'push':
            await queueTruncatedCommits(connectionId, payload);
            return submit(connectionId, buildPushRepository(connectionId, payload), 'push');

        case 'create':
            return submit(connectionId, buildBranchRepository(connectionId, payload), 'create');

        case 'pull_request':
            return submit(
                connectionId,
                await buildPullRequestRepository(connectionId, payload),
                'pull_request'
            );

        case 'delete':
            return handleDelete(connectionId, payload);

        case 'repository':
            return handleRepositoryEvent(connectionId, payload);

        // Forgejo Actions build results, read straight off the repository webhook.
        // The workflow file the admin page generates is still supported and is
        // still the only route for deployments and feature flags, but a customer
        // who wants builds alone no longer has to paste anything into a repository.
        case 'workflow_run':
            return handleWorkflowRun(connectionId, payload);

        default:
            console.log(`Ignoring unsupported Forgejo event type: ${eventType}`);
            return { statusCode: 200, body: `Ignored event: ${eventType}` };
    }
}

/**
 * Submit a built repository entity, or return early when the event referenced no
 * Jira issue. Returning early avoids burning a Jira API call on an irrelevant
 * event, which for a busy repository is the overwhelming majority of them.
 */
async function submit(connectionId, repository, eventType) {
    if (!repository) {
        console.log(`No Jira issue keys found in ${eventType} - skipping submission.`);
        return { statusCode: 200, body: 'No issue keys found; nothing submitted' };
    }

    const result = await submitDevInfo(repository);

    console.log(
        `Submitted ${result.submitted} ${eventType} entit${result.submitted === 1 ? 'y' : 'ies'} ` +
        `to Jira devinfo in ${result.batches} batch(es), ok=${result.ok}.`
    );

    return {
        statusCode: result.ok ? 202 : result.status,
        body: result.ok ? 'Accepted' : JSON.stringify(result.errors)
    };
}

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

/**
 * Build the repository entity for a push event.
 *
 * Forgejo caps the commits included in a push payload at `PAYLOAD_COMMIT_LIMIT`
 * (default 15). Commits beyond that are not lost permanently - the backfill
 * worker reads them from the REST API - but they will not appear from this
 * delivery alone.
 */
function buildPushRepository(connectionId, payload) {
    const updateSequenceId = Date.now();
    const rawCommits = Array.isArray(payload.commits) ? payload.commits : [];

    const commits = rawCommits
        .map((commit) => mapPushCommit(commit, updateSequenceId))
        .filter(Boolean);

    if (commits.length === 0) return undefined;

    return {
        ...repositoryEntity(connectionId, payload.repository, updateSequenceId),
        commits
    };
}

/**
 * Queue the commits a push payload left out.
 *
 * Forgejo caps the `commits` array at `PAYLOAD_COMMIT_LIMIT` (default 15) but
 * still reports the true size in `total_commits`. Merging a long-running branch
 * therefore delivers 15 commits and silently drops the rest, which is exactly the
 * moment a release's worth of issue keys goes missing.
 *
 * The remainder is read from Forgejo's compare API rather than from this
 * invocation, because a push of several thousand commits cannot be fetched,
 * mapped and submitted inside a web trigger's lifetime.
 *
 * Failure here must not fail the delivery: the commits that *did* arrive in the
 * payload are still worth submitting, and Forgejo retries a non-2xx by resending
 * the whole webhook, which would duplicate the queued work rather than repair it.
 */
async function queueTruncatedCommits(connectionId, payload) {
    const delivered = Array.isArray(payload.commits) ? payload.commits.length : 0;
    const total = Number(payload.total_commits);

    if (!Number.isFinite(total) || total <= delivered) return;

    const { before, after } = payload;
    if (!before || !after || isNullSha(before)) return;

    try {
        await startCommitRangeImport({
            connectionId,
            repoId: String(payload.repository?.id ?? ''),
            before,
            after
        });

        console.log(
            `Push carried ${delivered} of ${total} commits; queued ${before}...${after} ` +
            'to import the remainder.'
        );
    } catch (error) {
        console.error(`Could not queue the truncated commits of a push: ${error.message}`);
    }
}

/** Git's all-zero SHA, which Forgejo sends as `before` when a branch is created. */
function isNullSha(sha) {
    return /^0+$/.test(String(sha));
}

/**
 * Build the repository entity for a branch creation (`create`) event.
 *
 * Forgejo sends `create` for both branches and tags, distinguished by
 * `ref_type`. Tags carry no branch semantics in devinfo, so only branches are
 * forwarded.
 */
function buildBranchRepository(connectionId, payload) {
    if (payload.ref_type !== 'branch') return undefined;

    // Forgejo sends `refs/heads/ABC-1` here but `ABC-1` from the REST API, so the
    // ref is normalised before anything derives a name, an id or a URL from it.
    const branchName = shortBranchName(payload.ref);
    const issueKeys = extractIssueKeys(branchName);
    if (issueKeys.length === 0) return undefined;

    const repository = payload.repository ?? {};
    const updateSequenceId = Date.now();

    // Jira rejects a branch with no `lastCommit`, so one is synthesised from the
    // head SHA the create payload carries. Without a SHA there is nothing valid to
    // send, and the branch will be picked up by the next push or by backfill.
    const lastCommit = branchHeadCommit(
        {
            sha: payload.sha ?? payload.after,
            message: `Branch ${branchName} created`,
            repositoryUrl: repository.html_url,
            authorInfo: {
                name: payload.sender?.full_name || payload.sender?.login,
                email: payload.sender?.email,
                username: payload.sender?.login,
                avatarUrl: payload.sender?.avatar_url
            },
            issueKeys
        },
        updateSequenceId
    );

    if (!lastCommit) {
        console.warn(`Branch ${branchName} has no head SHA - cannot submit without lastCommit.`);
        return undefined;
    }

    const branch = mapBranch(
        {
            name: branchName,
            repositoryUrl: repository.html_url,
            lastCommit,
            defaultBranch: repository.default_branch
        },
        updateSequenceId
    );

    if (!branch) return undefined;

    return { ...repositoryEntity(connectionId, repository, updateSequenceId), branches: [branch] };
}

/**
 * Build the repository entity for any `pull_request*` event.
 */
async function buildPullRequestRepository(connectionId, payload) {
    const pr = payload.pull_request;
    if (!pr) return undefined;

    const updateSequenceId = Date.now();

    // Map once with no reviews purely to test for issue keys. A pull request that
    // names no issue is never submitted, so it must not cost a Forgejo API call -
    // on a busy repository that is most of the traffic.
    if (!mapPullRequest(pr, updateSequenceId)) return undefined;

    const reviews = await fetchReviews(connectionId, payload, pr);

    const pullRequest = mapPullRequest(pr, updateSequenceId, reviews);
    if (!pullRequest) return undefined;

    return {
        ...repositoryEntity(connectionId, payload.repository, updateSequenceId),
        pullRequests: [pullRequest]
    };
}

/**
 * Read the reviews left on a pull request, so reviewers show their real approval
 * state rather than all reading as unapproved.
 *
 * Best effort by design: an unreachable Forgejo, a revoked token or a repository
 * the token cannot see should cost the approval badges, not the whole pull
 * request. Returning an empty list degrades to the previous behaviour.
 */
async function fetchReviews(connectionId, payload, pr) {
    const owner = payload.repository?.owner?.login;
    const name = payload.repository?.name;
    const index = pr.number;

    if (!owner || !name || index == null) return [];

    try {
        const client = await createClient(connectionId);
        return (await client.listPullRequestReviews(owner, name, index)) ?? [];
    } catch (error) {
        console.warn(
            `Could not read reviews for ${owner}/${name}#${index}: ${error.message}. ` +
            'Submitting the pull request without approval state.'
        );
        return [];
    }
}

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

/**
 * Report a Forgejo Actions run to Jira's builds API.
 *
 * Forgejo only fires when a run reaches an outcome - action_run_success,
 * action_run_failure, action_run_recover - so a build appears once, already
 * finished. There is no event for a run starting, and so no in-progress build.
 * Jira still replaces a build when a later `updateSequenceNumber` arrives for the
 * same pipeline and build number, which is what a re-run produces.
 *
 * The connection identifier is part of the pipeline identity: Jira scopes builds
 * by pipeline and build number alone, with no repository field, so two
 * repositories that both have `ci.yml` would otherwise overwrite each other.
 */
async function handleWorkflowRun(connectionId, payload) {
    const connection = await getConnection(connectionId);
    const ignored = connection?.buildIgnoredWorkflows ?? [];

    if (!reportsBuilds(payload, ignored)) {
        const file = workflowFile(payload);
        console.log(`Workflow ${file} is excluded from build reporting - skipping.`);
        return { statusCode: 200, body: `Workflow ${file} excluded from builds` };
    }

    const build = mapWorkflowRun(payload, Date.now(), connectionId);

    if (!build) {
        console.log('Workflow run named no Jira issue - skipping submission.');
        return { statusCode: 200, body: 'No issue keys found; nothing submitted' };
    }

    const result = await submitBuilds([build]);

    console.log(
        `Submitted workflow run ${build.pipelineId}#${build.buildNumber} ` +
        `to Jira as "${build.state}" (ok=${result.ok}).`
    );

    return {
        statusCode: result.ok ? 202 : result.status,
        body: result.ok ? 'Accepted' : result.body
    };
}

// ---------------------------------------------------------------------------
// Deletions
// ---------------------------------------------------------------------------

/**
 * Handle a `delete` event, which Forgejo sends when a branch or tag is removed.
 *
 * Without this the development panel keeps offering a link to a branch that no
 * longer exists, which reads as the integration being out of date.
 */
async function handleDelete(connectionId, payload) {
    if (payload.ref_type !== 'branch') {
        return { statusCode: 200, body: 'Ignored non-branch deletion' };
    }

    const branchName = shortBranchName(payload.ref);
    if (extractIssueKeys(branchName).length === 0) {
        return { statusCode: 200, body: 'No issue keys found; nothing deleted' };
    }

    const repositoryId = devinfoRepositoryId(connectionId, payload.repository?.id);
    // Must be the same derivation `mapBranch` used to store it, or this addresses
    // an id that was never written and the stale branch survives the delete.
    const status = await deleteBranchEntity(repositoryId, branchEntityId(branchName));

    console.log(`Deleted branch ${branchName} from Jira devinfo (status ${status}).`);
    return { statusCode: 200, body: 'Branch removed' };
}

/**
 * Handle a `repository` event. Only deletion matters: when the repository is
 * gone, its development data should go with it rather than lingering as links
 * that 404.
 */
async function handleRepositoryEvent(connectionId, payload) {
    if (payload.action !== 'deleted') {
        return { statusCode: 200, body: `Ignored repository action: ${payload.action}` };
    }

    const repositoryId = devinfoRepositoryId(connectionId, payload.repository?.id);
    const status = await deleteRepositoryEntity(repositoryId);

    console.log(`Deleted repository ${repositoryId} from Jira devinfo (status ${status}).`);
    return { statusCode: 200, body: 'Repository removed' };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Forge supplies query parameters as arrays, because a parameter can legally
 * repeat. Only the first value is meaningful here.
 */
function firstQueryValue(queryParameters = {}, name) {
    const value = queryParameters?.[name];
    return Array.isArray(value) ? value[0] : value;
}
