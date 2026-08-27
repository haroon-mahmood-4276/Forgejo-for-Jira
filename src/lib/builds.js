import api, { route } from '@forge/api';
import { extractIssueKeys } from './issue-keys.js';

/**
 * Jira build submission, and the mapping from a Forgejo `workflow_run` webhook.
 *
 * Forgejo does emit a webhook when a workflow run finishes - `workflow_run`,
 * carrying the run and the status it moved to. That is worth taking seriously,
 * because the alternative this app shipped with is a workflow file the customer
 * has to paste into every repository, holding a signing secret they have to store
 * as a repository secret, doing HMAC in shell. Reading the run off the repository
 * webhook we already receive removes all of it.
 *
 * The workflow-file route still exists and is still the only way to report
 * deployments and feature flags, which have no Forgejo equivalent to read.
 */

/** Jira's build state enum. Shared with the Forgejo Actions reporter. */
export const BUILD_STATES = new Set([
    'pending',
    'in_progress',
    'successful',
    'failed',
    'cancelled',
    'unknown'
]);

/**
 * Jira's deployment state enum.
 *
 * The same as the build states plus `rolled_back`, which has no build
 * equivalent. Validating a deployment against BUILD_STATES would quietly record
 * a rollback as "unknown", so the two vocabularies are kept apart even though
 * they overlap almost entirely.
 */
export const DEPLOYMENT_STATES = new Set([...BUILD_STATES, 'rolled_back']);

/**
 * Forgejo's run status vocabulary, mapped onto Jira's.
 *
 * `skipped` becomes `cancelled` rather than `successful`: a skipped run proves
 * nothing about the code, and reporting it green would put a passing build on an
 * issue that was never actually built.
 */
const RUN_STATES = new Map([
    ['success', 'successful'],
    // action_run_recover fires when a run succeeds after the previous run of the
    // same workflow failed. It is a success; the name describes the transition.
    ['recover', 'successful'],
    ['failure', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['skipped', 'cancelled'],
    ['running', 'in_progress'],
    ['in_progress', 'in_progress'],
    ['waiting', 'pending'],
    ['queued', 'pending'],
    ['blocked', 'pending'],
    ['requested', 'pending']
]);

/**
 * An unrecognised state would fail the whole batch, so fall back to "unknown" -
 * showing a build with an unknown result is better than showing no build.
 */
export function normaliseBuildState(state) {
    return RUN_STATES.get(String(state ?? '').toLowerCase()) ?? 'unknown';
}

/**
 * Map a Forgejo `workflow_run` webhook onto a Jira build entity.
 *
 * `action` is the status the run just moved to and `run.status` is where it
 * currently sits; they agree on a finished run, and `action` is preferred because
 * it is the event being reported.
 *
 * Returns `undefined` when the run names no Jira issue, which on most
 * repositories is the majority of runs.
 */
export function workflowFile(payload = {}) {
    return String(payload.run?.workflow_id ?? '');
}

/**
 * Whether this run should be reported as a build.
 *
 * A workflow that reports its own deployment - the one the admin page
 * generates - would otherwise appear twice on the issue: once as the deployment
 * it reported, and once as a build nobody asked for. Jira cannot relate the two,
 * so the customer names those workflows and they are skipped here.
 *
 * Matching is on the workflow file, which is what Forgejo puts in `workflow_id`,
 * and is case-insensitive because a customer typing the name back in should not
 * have to match its case.
 */
export function reportsBuilds(payload, ignoredWorkflows = []) {
    const file = workflowFile(payload).toLowerCase();
    if (!file) return true;

    return !ignoredWorkflows.some(
        (ignored) => String(ignored).trim().toLowerCase() === file
    );
}

export function mapWorkflowRun(payload = {}, updateSequenceId = Date.now(), connectionId = '') {
    const run = payload.run ?? {};

    // The run's title is the commit subject or the pull request title, and
    // prettyref is the branch - the same two places a build's issue key is found
    // when the customer reports it from a workflow file.
    const issueKeys = extractIssueKeys(run.title, run.prettyref);
    if (issueKeys.length === 0) return undefined;

    const url = run.html_url;
    if (!url) return undefined;

    // Jira orders builds within a pipeline by buildNumber, so it has to be a
    // number and it has to increase. `index_in_repo` is Forgejo's per-repository
    // run counter, which is exactly that; `id` is the fallback.
    const buildNumber = Number(run.index_in_repo ?? run.id ?? 0);

    // One pipeline per workflow file, so runs of different workflows on the same
    // commit are separate rows rather than overwriting each other.
    //
    // Jira keys a build on pipelineId and buildNumber alone - the builds API has
    // no repository field - while Forgejo's buildNumber (index_in_repo) restarts
    // at 1 in every repository. Two connected repositories that both have
    // `ci.yml` would therefore collide on every run and silently overwrite each
    // other, so the connection and repository are part of the identity.
    const workflow = String(run.workflow_id || 'forgejo-actions');
    const repositoryName = run.repository?.name;
    const pipelineId = [connectionId, run.repository?.id, workflow]
        .filter((part) => part !== undefined && part !== null && part !== '')
        .join('-');

    return {
        schemaVersion: '1.0',
        pipelineId,
        buildNumber,
        updateSequenceNumber: updateSequenceId,
        // The pipeline's name, not the run's. Jira's build panel groups by this,
        // so putting the commit subject here - which changes every run - files
        // every build as its own pipeline instead of updating one row. The
        // repository is included because two repositories may both have `ci.yml`
        // and the panel would otherwise show two identically named rows.
        displayName: repositoryName ? `${repositoryName}/${workflow}` : workflow,
        url,
        state: normaliseBuildState(payload.action ?? run.status),
        lastUpdated: run.updated ?? run.stopped ?? new Date().toISOString(),
        issueKeys
    };
}

/**
 * Submit build entities to Jira's builds API.
 */
export async function submitBuilds(builds) {
    if (builds.length === 0) {
        return { ok: true, status: 200, body: '', submitted: 0 };
    }

    const response = await api.asApp().requestJira(route`/rest/builds/0.1/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ builds, providerMetadata: { product: 'Forgejo Actions' } })
    });

    const body = await response.text();

    if (!response.ok) {
        console.error(`Jira build submission failed (${response.status}):`, body);
    }

    return { ok: response.ok, status: response.status, body, submitted: builds.length };
}
