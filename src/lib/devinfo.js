import api, { route } from '@forge/api';
import { extractIssueKeys } from './issue-keys.js';

/**
 * Translation layer between Forgejo's data shapes and Jira's development
 * information API.
 *
 * Both the live webhook receiver and the backfill worker map into the same
 * entities, so the mapping lives here rather than in either caller. That also
 * keeps the one genuinely tricky detail - Forgejo returning *two different
 * shapes* for a commit depending on whether it came from a webhook or from the
 * REST API - in a single place.
 */

/**
 * Jira rejects an entire batch that carries more than 400 entities, so payloads
 * are split before submission rather than after a rejection.
 */
export const MAX_ENTITIES_PER_REQUEST = 400;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The identifier Jira stores for a repository.
 *
 * Forgejo's numeric repository ID is used rather than "owner/name" because the
 * numeric ID survives repository renames, so history stays attached to one
 * entry instead of forking into a duplicate. It is prefixed with the connection
 * ID because two different Forgejo instances connected to the same Jira site
 * will both happily number their first repository `1`.
 */
export function devinfoRepositoryId(connectionId, repoId) {
    return `${connectionId}-${repoId}`;
}

/**
 * Devinfo author objects need at least a name. Email is optional but is what
 * lets Jira match the author to a Jira user account, so it is included whenever
 * Forgejo gives us one.
 */
function author({ name, email, username, avatarUrl } = {}) {
    return {
        name: name || username || 'Unknown',
        email: email || undefined,
        username: username || undefined,
        avatar: avatarUrl || undefined
    };
}

// ---------------------------------------------------------------------------
// Repository entity
// ---------------------------------------------------------------------------

/**
 * Build the repository wrapper that every entity list hangs off.
 *
 * `repository` is Forgejo's repository object, which has the same field names in
 * webhook payloads and REST responses.
 */
export function repositoryEntity(connectionId, repository = {}, updateSequenceId = Date.now()) {
    return {
        id: devinfoRepositoryId(connectionId, repository.id ?? repository.full_name ?? 'unknown'),
        name: repository.full_name ?? repository.name ?? 'Unknown repository',
        description: repository.description || undefined,
        url: repository.html_url,
        avatar: repository.avatar_url || undefined,
        updateSequenceId
    };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/**
 * Map a commit from a **webhook push payload**.
 *
 * Shape: `{ id, message, url, author: { name, email, username }, timestamp,
 * added: [], removed: [], modified: [] }`.
 *
 * Returns `undefined` when the message references no Jira issue - Jira has
 * nowhere to display such a commit, so sending it wastes batch capacity.
 */
export function mapPushCommit(commit = {}, updateSequenceId = Date.now()) {
    const issueKeys = extractIssueKeys(commit.message);
    if (issueKeys.length === 0) return undefined;

    const sha = String(commit.id ?? '');
    if (!sha) return undefined;

    return {
        // `id` is the full SHA and is what Jira de-duplicates on.
        id: sha,
        hash: sha,
        // `displayId` is the short SHA rendered in the development panel.
        displayId: sha.substring(0, 7),
        message: commit.message ?? '',
        url: commit.url,
        author: author({
            name: commit.author?.name,
            email: commit.author?.email,
            username: commit.author?.username
        }),
        authorTimestamp: commit.timestamp,
        fileCount: countPushFiles(commit),
        issueKeys,
        updateSequenceId
    };
}

/**
 * Map a commit from the **Forgejo REST API** (`GET /repos/{o}/{r}/commits`).
 *
 * Shape differs from the webhook: the message and author sit under a nested
 * `commit` object, the SHA is `sha` rather than `id`, the browser link is
 * `html_url`, and changed files arrive as a single `files` array instead of
 * three add/remove/modify arrays.
 */
export function mapApiCommit(commit = {}, updateSequenceId = Date.now()) {
    const message = commit.commit?.message ?? '';
    const issueKeys = extractIssueKeys(message);
    if (issueKeys.length === 0) return undefined;

    const sha = String(commit.sha ?? '');
    if (!sha) return undefined;

    return {
        id: sha,
        hash: sha,
        displayId: sha.substring(0, 7),
        message,
        url: commit.html_url ?? commit.url,
        author: author({
            name: commit.commit?.author?.name,
            email: commit.commit?.author?.email,
            username: commit.author?.login,
            avatarUrl: commit.author?.avatar_url
        }),
        authorTimestamp: commit.commit?.author?.date ?? commit.created,
        // `files` is only populated when the API is asked for it; absent means we
        // genuinely do not know, and 0 is the honest answer Jira accepts.
        fileCount: Array.isArray(commit.files) ? commit.files.length : 0,
        issueKeys,
        updateSequenceId
    };
}

/**
 * Forgejo webhook commits report changed paths as three separate arrays. Jira
 * only wants the total, and the arrays are absent on some delivery shapes.
 */
function countPushFiles(commit) {
    const added = commit.added?.length ?? 0;
    const removed = commit.removed?.length ?? 0;
    const modified = commit.modified?.length ?? 0;
    return added + removed + modified;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

/**
 * Reduce a git ref to the branch name.
 *
 * Forgejo is inconsistent about which form it sends: the REST branch listing
 * returns `ABC-1`, while `create` and `push` webhooks send `refs/heads/ABC-1`.
 * Left alone, the same branch arrives under two names and Jira stores it as two
 * separate entities - and neither of them matches the `sourceBranch` a pull
 * request reports, so the development panel's "Pull request" column stays empty.
 * Normalising here means every producer agrees on one name.
 */
export function shortBranchName(ref) {
    return String(ref ?? '').replace(/^refs\/heads\//, '');
}

/**
 * The identifier Jira stores a branch under.
 *
 * Jira validates branch ids against `[A-Za-z0-9\-._~]+` and rejects the whole
 * batch with `devInformation.repository.branch.id.invalid` otherwise, but a
 * perfectly ordinary branch name like `feature/ABC-1` contains a slash. The id is
 * therefore a sanitised derivative while `name` keeps the real branch name, which
 * is what Jira matches pull requests against and what a human expects to read.
 *
 * Every code path that names a branch to Jira - creating one, deleting one - must
 * go through this, or a delete will address an id that was never stored.
 */
export function branchEntityId(name) {
    return shortBranchName(name).replace(/[^A-Za-z0-9\-._~]/g, '-');
}

/**
 * The Forgejo URL of a branch.
 *
 * Jira ties a pull request to a branch by comparing the pull request's
 * `sourceBranchUrl` with the branch's `url`, not by comparing their names, so the
 * two must be built the same way down to the escaping. Both callers go through
 * here rather than formatting their own.
 */
export function branchUrl(repositoryUrl, name) {
    return `${repositoryUrl}/src/branch/${encodeURIComponent(shortBranchName(name))}`;
}

/**
 * Build a branch entity.
 *
 * Jira rejects a branch that carries no `lastCommit`, reporting
 * `devInformation.repository.branch.lastCommit.required`, even though the
 * published schema marks the field optional. Callers must therefore supply a
 * commit; `undefined` is returned when they cannot, so the caller can skip the
 * branch instead of failing the whole batch.
 */
export function mapBranch(
    { name, repositoryUrl, lastCommit, extraIssueKeys = [], defaultBranch },
    updateSequenceId = Date.now()
) {
    const branchName = shortBranchName(name);

    const issueKeys = extractIssueKeys(branchName, ...extraIssueKeys);
    if (issueKeys.length === 0) return undefined;
    if (!lastCommit) return undefined;

    const branch = {
        id: branchEntityId(branchName),
        name: branchName,
        url: branchUrl(repositoryUrl, branchName),
        lastCommit,
        issueKeys,
        updateSequenceId
    };

    // Fills the "Action" column of the development panel's branch list. Forgejo's
    // compare URL needs an explicit base, so this is only offered when the caller
    // knows the repository's default branch - and never for the default branch
    // itself, which has nothing to open a pull request against.
    const base = shortBranchName(defaultBranch);
    if (base && base !== branchName) {
        branch.createPullRequestUrl =
            `${repositoryUrl}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branchName)}`;
    }

    return branch;
}

/**
 * Synthesise the `lastCommit` entity for a branch from whatever the caller
 * knows about its head commit.
 *
 * A branch's head commit very often has a message with no issue key in it (a
 * branch named ABC-1-fix can point at a commit saying "wip"), so unlike
 * `mapPushCommit` this deliberately does *not* drop the commit for having no
 * keys - it inherits the branch's keys instead.
 */
export function branchHeadCommit(
    { sha, message, repositoryUrl, authorInfo, timestamp, issueKeys },
    updateSequenceId = Date.now()
) {
    if (!sha) return undefined;

    const hash = String(sha);

    return {
        id: hash,
        hash,
        displayId: hash.substring(0, 7),
        message: message || '(no commit message)',
        url: `${repositoryUrl}/commit/${hash}`,
        author: author(authorInfo),
        authorTimestamp: timestamp ?? new Date().toISOString(),
        fileCount: 0,
        issueKeys,
        updateSequenceId
    };
}

/**
 * Map a branch from `GET /repos/{o}/{r}/branches`.
 *
 * Shape: `{ name, commit: { id, message, timestamp, author: { name, email,
 * username } } }`.
 */
export function mapApiBranch(
    branch = {},
    repositoryUrl,
    updateSequenceId = Date.now(),
    defaultBranch
) {
    const issueKeys = extractIssueKeys(shortBranchName(branch.name));
    if (issueKeys.length === 0) return undefined;

    const lastCommit = branchHeadCommit(
        {
            sha: branch.commit?.id,
            message: branch.commit?.message,
            repositoryUrl,
            authorInfo: {
                name: branch.commit?.author?.name,
                email: branch.commit?.author?.email,
                username: branch.commit?.author?.username
            },
            timestamp: branch.commit?.timestamp,
            issueKeys
        },
        updateSequenceId
    );

    return mapBranch(
        { name: branch.name, repositoryUrl, lastCommit, defaultBranch },
        updateSequenceId
    );
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/**
 * Map a pull request. Forgejo returns the same structure from the
 * `pull_request` webhook and from `GET /repos/{o}/{r}/pulls`, so one mapper
 * serves both.
 *
 * Keys are read from the title *and* the source branch name, because teams
 * commonly encode the issue key in one or the other.
 *
 * The branch URLs matter as much as the branch names: Jira fills the "Pull
 * request" column of an issue's branch list by matching `sourceBranchUrl` against
 * a branch entity's `url`, and leaves the column empty when it is absent even
 * though both entities are present and identically named. The head repository is
 * used for the source so that a pull request opened from a fork points at the
 * fork, which is where that branch actually lives.
 */
export function mapPullRequest(pr = {}, updateSequenceId = Date.now(), reviews = []) {
    const sourceBranch = shortBranchName(pr.head?.ref ?? '');
    const destinationBranch = shortBranchName(pr.base?.ref ?? '');
    const issueKeys = extractIssueKeys(pr.title, sourceBranch);
    if (issueKeys.length === 0) return undefined;

    // Jira keys a pull request on `id` and requires `url`; a payload missing
    // either cannot be represented and would fail the whole batch it rode in on.
    if (pr.number === undefined || pr.number === null || !pr.html_url) return undefined;

    const sourceRepoUrl = pr.head?.repo?.html_url;
    const destinationRepoUrl = pr.base?.repo?.html_url;

    return {
        id: String(pr.number),
        displayId: `#${pr.number}`,
        title: pr.title,
        url: pr.html_url,
        author: author({
            name: pr.user?.full_name || pr.user?.login,
            email: pr.user?.email,
            username: pr.user?.login,
            avatarUrl: pr.user?.avatar_url
        }),
        status: mapPullRequestStatus(pr),
        sourceBranch,
        ...(sourceRepoUrl && sourceBranch
            ? { sourceBranchUrl: branchUrl(sourceRepoUrl, sourceBranch) }
            : {}),
        destinationBranch,
        ...(destinationRepoUrl && destinationBranch
            ? { destinationBranchUrl: branchUrl(destinationRepoUrl, destinationBranch) }
            : {}),
        reviewers: mapReviewers(pr, reviews),
        commentCount: pr.comments ?? 0,
        lastUpdate: pr.updated_at,
        issueKeys,
        updateSequenceId
    };
}

/**
 * Map Forgejo's pull request state onto Jira's enum (OPEN, MERGED, DECLINED,
 * DRAFT, UNKNOWN).
 *
 * Forgejo reports `state` as "open" or "closed" with a separate `merged`
 * boolean, so a merged pull request has to be detected *before* the closed case,
 * otherwise every merge would display as declined.
 */
export function mapPullRequestStatus(pr = {}) {
    if (pr.merged) return 'MERGED';
    if (pr.draft) return 'DRAFT';
    if (pr.state === 'closed') return 'DECLINED';
    if (pr.state === 'open') return 'OPEN';
    return 'UNKNOWN';
}

/**
 * Forgejo review states that represent a completed review. `PENDING` is a draft
 * the reviewer has not submitted, and is nobody's business but theirs.
 */
const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']);

/**
 * Build the reviewer list Jira renders as avatars plus an approval count.
 *
 * Two sources have to be combined, because neither is complete on its own:
 *
 *  - `requested_reviewers` on the pull request is who was *asked*. Forgejo removes
 *    a reviewer from it the moment they actually review, so on its own it hides
 *    exactly the people whose opinion arrived.
 *  - `reviews` is who *responded*, which is where an approval can be read from.
 *
 * A reviewer present in both must appear once, carrying their reviewed state, so
 * the merge is keyed on identity rather than on which list they came from.
 */
function mapReviewers(pr = {}, reviews = []) {
    const requested = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
    const submitted = Array.isArray(reviews) ? reviews : [];

    const byIdentity = new Map();

    for (const reviewer of requested.filter(Boolean)) {
        const key = reviewerKey(reviewer);
        if (key) byIdentity.set(key, { user: reviewer, approved: false });
    }

    // Forgejo returns reviews oldest first, so later entries overwrite earlier
    // ones and each reviewer ends up on their most recent verdict - an approval
    // that was followed by a request for changes must not still read as approved.
    for (const review of submitted.filter(Boolean)) {
        const state = String(review.state ?? '').toUpperCase();
        if (!SUBMITTED_REVIEW_STATES.has(state)) continue;

        const user = review.user ?? {};
        const key = reviewerKey(user);
        if (!key) continue;

        // A comment-only review does not change an approval already given; it is
        // only evidence that this person is a reviewer at all.
        const existing = byIdentity.get(key);
        const approved = state === 'APPROVED'
            ? true
            : state === 'REQUEST_CHANGES'
                ? false
                : existing?.approved ?? false;

        byIdentity.set(key, { user, approved });
    }

    return [...byIdentity.values()].map(({ user, approved }) => ({
        name: user.full_name || user.login || 'Unknown',
        email: user.email || undefined,
        approvalStatus: approved ? 'APPROVED' : 'UNAPPROVED'
    }));
}

/** Identify a reviewer across both lists. Login is stable; display names are not. */
function reviewerKey(user = {}) {
    return user.login || user.email || user.full_name || undefined;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Submit one repository's entities to Jira, splitting into batches that stay
 * under Jira's 400-entity limit.
 *
 * `repository` is the wrapper from `repositoryEntity()` plus any of `commits`,
 * `branches` and `pullRequests`. Returns a summary rather than a raw response
 * because callers batch, and a single status code would be misleading.
 */
export async function submitDevInfo(repository) {
    const commits = repository.commits ?? [];
    const branches = repository.branches ?? [];
    const pullRequests = repository.pullRequests ?? [];

    const total = commits.length + branches.length + pullRequests.length;
    if (total === 0) {
        return { submitted: 0, batches: 0, ok: true, status: 200, errors: [] };
    }

    const base = { ...repository };
    delete base.commits;
    delete base.branches;
    delete base.pullRequests;

    const batches = buildBatches(base, commits, branches, pullRequests);
    const errors = [];
    let lastStatus = 200;

    for (const batch of batches) {
        const response = await api.asApp().requestJira(route`/rest/devinfo/0.10/bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                repositories: [batch],
                // Commits must never drive workflow transitions on their own; Smart
                // Commit handling is an explicit non-goal of this app.
                preventTransitions: true,
                providerMetadata: { product: 'Forgejo' }
            })
        });

        lastStatus = response.status;

        if (!response.ok) {
            // Jira's devinfo errors name the offending field, so surface them intact.
            const text = await response.text();
            console.error(`Jira devinfo submission failed (${response.status}): ${text}`);
            errors.push({ status: response.status, body: text });
        }
    }

    return {
        submitted: total,
        batches: batches.length,
        ok: errors.length === 0,
        status: errors.length === 0 ? lastStatus : errors[0].status,
        errors
    };
}

/**
 * Split entity lists into repository payloads of at most
 * `MAX_ENTITIES_PER_REQUEST` entities each. Every batch repeats the repository
 * wrapper, which is what Jira expects - the wrapper is not a create-once record.
 */
function buildBatches(base, commits, branches, pullRequests) {
    const batches = [];
    let current = { ...base };
    let count = 0;

    const push = (field, entity) => {
        if (count >= MAX_ENTITIES_PER_REQUEST) {
            batches.push(current);
            current = { ...base };
            count = 0;
        }
        current[field] = current[field] ?? [];
        current[field].push(entity);
        count += 1;
    };

    for (const commit of commits) push('commits', commit);
    for (const branch of branches) push('branches', branch);
    for (const pullRequest of pullRequests) push('pullRequests', pullRequest);

    if (count > 0) batches.push(current);

    return batches;
}

/**
 * Remove a whole repository from the development panel.
 *
 * Called when an admin disconnects a repository, so Jira stops showing
 * development data the customer no longer wants linked.
 */
export async function deleteRepositoryEntity(repositoryId) {
    const response = await api
        .asApp()
        .requestJira(route`/rest/devinfo/0.10/repository/${repositoryId}`, { method: 'DELETE' });

    if (!response.ok && response.status !== 404) {
        console.error(
            `Failed to delete repository ${repositoryId} from Jira (${response.status}):`,
            await response.text()
        );
    }

    return response.status;
}

/**
 * Remove a single branch entity, used when Forgejo reports a branch deletion.
 * Without this the development panel keeps offering a link to a branch that no
 * longer exists.
 */
export async function deleteBranchEntity(repositoryId, branchId) {
    const response = await api
        .asApp()
        .requestJira(
            route`/rest/devinfo/0.10/repository/${repositoryId}/branch/${branchId}?_updateSequenceId=${String(Date.now())}`,
            { method: 'DELETE' }
        );

    if (!response.ok && response.status !== 404) {
        console.error(
            `Failed to delete branch ${branchId} from Jira (${response.status}):`,
            await response.text()
        );
    }

    return response.status;
}
