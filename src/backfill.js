import { InvocationError, InvocationErrorCode, Queue } from '@forge/events';
import { createClient } from './lib/forgejo-client.js';
import {
    mapApiBranch,
    mapApiCommit,
    mapPullRequest,
    repositoryEntity,
    submitDevInfo
} from './lib/devinfo.js';
import { getConnection, getRepository, saveRepository } from './lib/storage.js';

/**
 * Historical import of a repository's commits, branches and pull requests.
 *
 * A webhook only ever tells you what just happened. Connecting a repository that
 * has two years of history would leave every existing issue with an empty
 * development panel, so on connect the whole repository is read back through
 * Forgejo's REST API and submitted to Jira.
 *
 * This cannot run in one go. A Forge function invocation is limited to seconds,
 * while a large repository is tens of thousands of commits. So the work is
 * broken into one *page* per invocation: each run reads a single page from
 * Forgejo, submits it, then pushes a follow-up job for the next page onto the
 * async event queue. Progress is stored on the repository record, which is what
 * lets the admin page show a live count and what lets a failed run resume rather
 * than restart.
 */

/** The queue is declared in `manifest.yml` under `consumer`. */
export const backfillQueue = new Queue({ key: 'forgejo-backfill' });

/**
 * The phases, in the order they run.
 *
 * Branches and pull requests come first because they are few and give the admin
 * visible progress within seconds. Commits are last because they are by far the
 * largest set and the least urgent - a branch already links the issue to the
 * repository.
 */
const PHASES = ['branches', 'pullRequests', 'commits'];

/**
 * Queue an import of one commit range.
 *
 * Used when a push webhook reports more commits than Forgejo was willing to put
 * in its payload. Deliberately separate from the phase machine below: this is a
 * bounded one-off, and it must not disturb the recorded progress of a full
 * backfill that may be running for the same repository.
 */
export async function startCommitRangeImport({ connectionId, repoId, before, after }) {
    return backfillQueue.push({
        body: { connectionId, repoId: String(repoId), range: { before, after } }
    });
}

/**
 * Queue a full backfill for a repository, replacing any progress already
 * recorded. Called when a repository is connected, and when an admin asks for a
 * re-sync.
 */
export async function startBackfill(connectionId, repoId) {
    const repo = await getRepository(connectionId, repoId);
    if (!repo) throw new Error('That repository is not connected.');

    // Repositories connected before the default branch was recorded have no way to
    // build a "create pull request" URL. A re-import is the natural moment to fill
    // that in, and best effort: an unreachable Forgejo costs the branch action, not
    // the import.
    if (!repo.defaultBranch) {
        try {
            const client = await createClient(connectionId);
            const remote = await client.getRepository(repo.owner, repo.name);
            if (remote?.default_branch) repo.defaultBranch = remote.default_branch;
        } catch (error) {
            console.warn(
                `Could not read the default branch of ${repo.fullName}: ${error.message}.`
            );
        }
    }

    const queued = {
        status: 'queued',
        phase: PHASES[0],
        page: 1,
        counts: { commits: 0, branches: 0, pullRequests: 0 },
        startedAt: Date.now(),
        finishedAt: undefined,
        error: undefined
    };

    await saveRepository({ ...repo, backfill: queued });

    try {
        const { jobId } = await backfillQueue.push({
            body: { connectionId, repoId: String(repoId), phase: PHASES[0], page: 1 }
        });

        return { jobId };
    } catch (error) {
        // The progress record is written before the push so the admin sees the work
        // start immediately. If the push then fails, that record has to be corrected
        // or the repository is stuck reading "queued" forever - work that will never
        // run, with the page polling for a change that can never come.
        await saveRepository({
            ...repo,
            backfill: { ...queued, status: 'failed', error: error.message, finishedAt: Date.now() }
        });

        throw error;
    }
}

/**
 * Process one page of one phase.
 *
 * Returning normally marks the event consumed. Returning an `InvocationError`
 * asks Forge to retry the same event later, which is the right response to a
 * Forgejo instance that is briefly unreachable or rate limiting us - the
 * alternative is losing the rest of the repository's history to a blip.
 */
async function processPage(payload = {}) {
    const { connectionId, repoId, phase, page } = payload;

    const repo = await getRepository(connectionId, repoId);
    if (!repo) {
        console.log(`Backfill for ${connectionId}/${repoId} stopped: repository was disconnected.`);
        return;
    }

    const connection = await getConnection(connectionId);
    if (!connection) {
        console.log(`Backfill for ${connectionId}/${repoId} stopped: connection was removed.`);
        return;
    }

    let client;
    try {
        client = await createClient(connectionId);
    } catch (error) {
        // A missing or unauthorized connection will not fix itself on retry, so this
        // is recorded as a terminal failure rather than retried forever.
        await recordFailure(repo, error.message);
        return;
    }

    try {
        const { items, hasMore } = await fetchPage(client, repo, phase, page);
        const submitted = await submitPage(connectionId, repo, phase, items);

        const counts = { ...repo.backfill?.counts };
        counts[phase] = (counts[phase] ?? 0) + submitted;

        const next = nextStep(phase, page, hasMore);

        await saveRepository({
            ...repo,
            backfill: {
                ...repo.backfill,
                status: next ? 'running' : 'complete',
                phase: next?.phase ?? phase,
                page: next?.page ?? page,
                counts,
                finishedAt: next ? undefined : Date.now(),
                error: undefined
            }
        });

        if (next) {
            await backfillQueue.push({ body: { connectionId, repoId, ...next } });
        } else {
            console.log(
                `Backfill complete for ${repo.fullName}: ` +
                `${counts.commits ?? 0} commits, ${counts.branches ?? 0} branches, ` +
                `${counts.pullRequests ?? 0} pull requests.`
            );
        }
    } catch (error) {
        console.error(`Backfill page failed for ${repo.fullName} (${phase} p${page}):`, error.message);

        // Record the error so the admin page can show it, then ask for a retry.
        // Forge gives up after its own retry budget, at which point the stored
        // status stays on the failure and the admin can re-sync manually.
        await saveRepository({
            ...repo,
            backfill: { ...repo.backfill, status: 'running', error: error.message }
        });

        return new InvocationError({
            retryAfter: 60,
            retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
            retryData: { phase, page }
        });
    }
}

/**
 * Read one page from Forgejo for the given phase.
 */
async function fetchPage(client, repo, phase, page) {
    switch (phase) {
        case 'branches':
            return client.listBranches(repo.owner, repo.name, page);
        case 'pullRequests':
            return client.listPullRequests(repo.owner, repo.name, page);
        case 'commits':
            return client.listCommits(repo.owner, repo.name, page);
        default:
            throw new Error(`Unknown backfill phase: ${phase}`);
    }
}

/**
 * Map a page and send it to Jira. Returns how many entities were actually
 * submitted, which is usually fewer than were read - anything with no issue key
 * in it is dropped, and on most repositories that is the majority.
 */
async function submitPage(connectionId, repo, phase, items) {
    const updateSequenceId = Date.now();

    const mapped = items
        .map((item) => mapItem(phase, item, repo, updateSequenceId))
        .filter(Boolean);

    if (mapped.length === 0) return 0;

    const repository = {
        ...repositoryEntity(
            connectionId,
            { id: repo.repoId, full_name: repo.fullName, html_url: repo.htmlUrl },
            updateSequenceId
        ),
        [phaseField(phase)]: mapped
    };

    const result = await submitDevInfo(repository);

    if (!result.ok) {
        throw new Error(`Jira rejected a ${phase} batch: ${JSON.stringify(result.errors)}`);
    }

    return mapped.length;
}

function mapItem(phase, item, repo, updateSequenceId) {
    switch (phase) {
        case 'branches':
            return mapApiBranch(item, repo.htmlUrl, updateSequenceId, repo.defaultBranch);
        case 'pullRequests':
            return mapPullRequest(item, updateSequenceId);
        case 'commits':
            return mapApiCommit(item, updateSequenceId);
        default:
            return undefined;
    }
}

/** The devinfo field each phase writes into. */
function phaseField(phase) {
    return phase === 'commits' ? 'commits' : phase === 'branches' ? 'branches' : 'pullRequests';
}

/**
 * Decide what runs next: the next page of this phase, the first page of the next
 * phase, or nothing because the repository is done.
 */
function nextStep(phase, page, hasMore) {
    if (hasMore) return { phase, page: page + 1 };

    const nextPhase = PHASES[PHASES.indexOf(phase) + 1];
    return nextPhase ? { phase: nextPhase, page: 1 } : undefined;
}

async function recordFailure(repo, message) {
    console.error(`Backfill for ${repo.fullName} failed permanently: ${message}`);
    await saveRepository({
        ...repo,
        backfill: { ...repo.backfill, status: 'failed', error: message, finishedAt: Date.now() }
    });
}

/**
 * Entry point for queued events.
 *
 * The `consumer` module names this function directly rather than going through a
 * resolver, so Forge hands over the async event itself. The payload pushed onto
 * the queue arrives as `body`; `payload` is accepted as well because the older
 * resolver-based delivery used that name, and being tolerant here costs nothing
 * while a mismatch would silently drop every job.
 */
export async function handler(event = {}) {
    const payload = event.body ?? event.payload ?? {};

    return payload.range ? processCommitRange(payload) : processPage(payload);
}

/**
 * Import the commits between two revisions, for a push whose payload Forgejo
 * truncated.
 *
 * Unlike the phase machine this writes no progress to the repository record. It
 * is repairing one delivery, not tracking the state of a repository, and
 * overwriting `backfill` here would corrupt the admin page's view of a real
 * backfill running alongside it.
 */
async function processCommitRange(payload = {}) {
    const { connectionId, repoId, range } = payload;

    const repo = await getRepository(connectionId, repoId);
    if (!repo) {
        console.log(`Commit range import stopped: ${connectionId}/${repoId} was disconnected.`);
        return;
    }

    let client;
    try {
        client = await createClient(connectionId);
    } catch (error) {
        // Not retryable - a missing connection or revoked token will not recover
        // by trying again.
        console.error(`Commit range import for ${repo.fullName} abandoned: ${error.message}`);
        return;
    }

    try {
        const comparison = await client.compareCommits(
            repo.owner,
            repo.name,
            range.before,
            range.after
        );

        const commits = Array.isArray(comparison?.commits) ? comparison.commits : [];
        const submitted = await submitPage(connectionId, repo, 'commits', commits);

        console.log(
            `Imported ${submitted} of ${commits.length} commits from ` +
            `${range.before}...${range.after} on ${repo.fullName}.`
        );
    } catch (error) {
        console.error(`Commit range import failed for ${repo.fullName}:`, error.message);

        return new InvocationError({
            retryAfter: 60,
            retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
            retryData: { range }
        });
    }
}
