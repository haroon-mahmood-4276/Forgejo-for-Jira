import api, { route } from '@forge/api';
// Jira's build state enum is shared with the `workflow_run` webhook path, so the
// two routes into the builds API cannot disagree about what Jira accepts.
import { BUILD_STATES, DEPLOYMENT_STATES } from './lib/builds.js';
import { authenticateDelivery } from './lib/delivery.js';
import { extractIssueKeys, isIssueKey } from './lib/issue-keys.js';

/**
 * Receives build, deployment and feature flag reports from Forgejo Actions.
 *
 * Builds no longer need this: Forgejo emits a `workflow_run` webhook and the
 * repository webhook receiver reports those directly, so a customer who only
 * wants build results has nothing to paste anywhere. This trigger remains the
 * route for deployments and feature flags, which Forgejo has no equivalent of and
 * so can only be reported by the customer's own workflow, and it still serves
 * builds for anyone already using the generated workflow file.
 *
 * A step at the end of the customer's workflow posts a small JSON document here,
 * signed with the same HMAC scheme the repository webhook uses and selecting the
 * connection with the same `?c=` parameter. The payload shape is defined by this
 * app; the admin page generates a ready-to-paste workflow that produces it.
 *
 * Validation happens here rather than being left to Jira. Jira answers a bad
 * document with a 400 naming a schema path, which the app relays as a 502 - true
 * but unhelpful to the person editing a workflow file. A missing field they can
 * fix is reported as a 400 that names the field.
 */

/** Jira's deployment environment type enum. */
const ENVIRONMENT_TYPES = new Set([
    'unmapped',
    'development',
    'testing',
    'staging',
    'production'
]);

/**
 * Jira's feature flag environment type enum, which is the deployment one minus
 * `unmapped`. Sending `unmapped` here fails the whole flag with
 * "'details.environment.type' is not valid", so the two cannot share a
 * normaliser: a deployment to an unrecognised environment degrades to unmapped
 * and still appears, while a flag would simply vanish.
 */
const FLAG_ENVIRONMENT_TYPES = new Set([
    'development',
    'testing',
    'staging',
    'production'
]);

export async function handleCiStatus(request) {
    const delivery = await authenticateDelivery(request, 'CI status');
    if (!delivery.ok) return delivery.response;

    const { payload } = delivery;

    const issueKeys = resolveIssueKeys(payload);
    if (issueKeys.length === 0) {
        console.log('CI status carried no issue keys - skipping submission.');
        return { statusCode: 200, body: 'No issue keys; nothing submitted' };
    }

    if (payload.type === 'build') return submitBuild(payload, issueKeys);
    if (payload.type === 'deployment') return submitDeployment(payload, issueKeys);
    if (payload.type === 'featureFlag') return submitFeatureFlag(payload, issueKeys);

    console.log(`Ignoring unsupported CI status type: ${payload.type}`);
    return { statusCode: 400, body: `Unsupported type: ${payload.type}` };
}

/**
 * Work out which issues a build or deployment belongs to.
 *
 * A workflow can pass `issueKeys` explicitly, but making that the only option
 * would force every customer to write shell that parses issue keys out of git
 * themselves. So `ref` and `commitMessage` are also scanned, which is what the
 * generated workflow relies on - it simply passes through the branch name and
 * the commit subject.
 *
 * Explicit keys are still checked against the issue-key shape. A caller cannot
 * fail the whole batch with one malformed entry, and nothing that is not an
 * issue key is ever forwarded to Jira as one.
 */
function resolveIssueKeys(payload) {
    const explicit = Array.isArray(payload.issueKeys)
        ? payload.issueKeys
            .filter((key) => typeof key === 'string')
            .map((key) => key.trim())
            .filter(isIssueKey)
        : [];

    if (explicit.length > 0) return [...new Set(explicit)];

    return extractIssueKeys(payload.ref, payload.commitMessage, payload.displayName);
}

/**
 * Submit a build result to Jira's builds API.
 */
async function submitBuild(payload, issueKeys) {
    const url = requireUrl(payload);
    if (!url) return badRequest('build', '"url" is required and must be an absolute URL');

    const body = {
        builds: [
            {
                schemaVersion: '1.0',
                pipelineId: optionalString(payload.pipelineId, 'forgejo-actions'),
                // Jira orders builds within a pipeline by `buildNumber`, so it has to be
                // a number rather than a string.
                buildNumber: toNumber(payload.buildNumber, 0),
                updateSequenceNumber: Date.now(),
                displayName: optionalString(
                    payload.displayName,
                    `Build ${payload.buildNumber ?? ''}`.trim()
                ),
                url,
                state: normaliseState(payload.state, BUILD_STATES),
                lastUpdated: optionalString(payload.lastUpdated, new Date().toISOString()),
                issueKeys
            }
        ],
        providerMetadata: { product: 'Forgejo Actions' }
    };

    return submit(route`/rest/builds/0.1/bulk`, body, 'build');
}

/**
 * Submit a deployment result to Jira's deployments API.
 */
async function submitDeployment(payload, issueKeys) {
    const url = requireUrl(payload);
    if (!url) return badRequest('deployment', '"url" is required and must be an absolute URL');

    const environmentId = optionalString(payload.environment, 'unmapped');
    const environmentType = normaliseEnvironmentType(environmentId);
    const pipelineId = optionalString(payload.pipelineId, 'forgejo-actions');
    const sequence = Date.now();

    const body = {
        deployments: [
            {
                schemaVersion: '1.0',
                // Orders deployments to the same environment.
                deploymentSequenceNumber: toNumber(payload.deploymentSequenceNumber, sequence),
                updateSequenceNumber: sequence,
                displayName: optionalString(payload.displayName, `Deployment to ${environmentId}`),
                url,
                description: optionalString(
                    payload.description,
                    optionalString(payload.displayName, 'Forgejo Actions deployment')
                ),
                lastUpdated: optionalString(payload.lastUpdated, new Date().toISOString()),
                state: normaliseState(payload.state, DEPLOYMENT_STATES),
                pipeline: {
                    id: pipelineId,
                    displayName: pipelineId === 'forgejo-actions' ? 'Forgejo Actions' : pipelineId,
                    url
                },
                environment: {
                    id: environmentId,
                    displayName: optionalString(payload.environmentName, environmentId),
                    type: environmentType
                },
                issueKeys
            }
        ],
        providerMetadata: { product: 'Forgejo Actions' }
    };

    return submit(route`/rest/deployments/0.1/bulk`, body, 'deployment');
}

/**
 * Submit a feature flag to Jira's feature flags API.
 *
 * Forgejo has no notion of a feature flag, so unlike commits or pull requests
 * there is nothing to read out of it. The flag is whatever the customer's own
 * tooling reports - a deploy script, a workflow step, or their flag provider's
 * webhook forwarded through this trigger - which is why this shares the CI
 * trigger's shape and signing rather than being a second, near-identical one.
 */
async function submitFeatureFlag(payload, issueKeys) {
    const key = optionalString(payload.key, optionalString(payload.id, ''));

    if (!key) {
        console.warn('Feature flag report carried no key - nothing to identify it by.');
        return badRequest('feature flag', '"key" is required');
    }

    const url = requireUrl(payload);
    const lastUpdated = optionalString(payload.lastUpdated, new Date().toISOString());

    // Jira requires an explicit rollout only when a percentage is given; sending
    // `percentage: undefined` would fail validation, so it is built conditionally.
    const percentage = Number(payload.rolloutPercentage);
    const status = {
        enabled: Boolean(payload.enabled),
        defaultValue: String(payload.defaultValue ?? (payload.enabled ? 'true' : 'false')),
        ...(payload.rolloutPercentage !== undefined &&
        payload.rolloutPercentage !== null &&
        Number.isFinite(percentage)
            ? { rollout: { percentage } }
            : {})
    };

    const body = {
        flags: [
            {
                schemaVersion: '1.0',
                // `id` is what Jira de-duplicates on; the key is the human-facing
                // name and the two are the same thing unless the caller separates
                // them.
                id: optionalString(payload.id, key),
                key,
                updateSequenceId: Date.now(),
                displayName: optionalString(payload.displayName, key),
                issueKeys,
                summary: {
                    ...(url ? { url } : {}),
                    status,
                    lastUpdated
                },
                details: [
                    {
                        ...(url ? { url } : {}),
                        lastUpdated,
                        environment: {
                            name: optionalString(
                                payload.environmentName,
                                optionalString(payload.environment, 'production')
                            ),
                            type: normaliseFlagEnvironmentType(payload.environment)
                        },
                        status
                    }
                ]
            }
        ],
        providerMetadata: { product: 'Forgejo' }
    };

    return submit(route`/rest/featureflags/0.1/bulk`, body, 'feature flag');
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

/**
 * Jira rejects a batch whose environment type it does not recognise, so anything
 * unknown is reported as "unmapped" rather than losing the whole submission.
 */
function normaliseEnvironmentType(environment) {
    const normalised = String(environment ?? '').toLowerCase();
    return ENVIRONMENT_TYPES.has(normalised) ? normalised : 'unmapped';
}

/**
 * Feature flags have no "unmapped" to fall back on, so an unrecognised
 * environment is reported as production - the conservative reading, since a flag
 * whose environment nobody named is more likely live than not, and the
 * customer's own name for it is still carried in `name`.
 */
function normaliseFlagEnvironmentType(environment) {
    const normalised = String(environment ?? '').toLowerCase();
    return FLAG_ENVIRONMENT_TYPES.has(normalised) ? normalised : 'production';
}

/**
 * An unrecognised state would fail the whole batch, so fall back to "unknown" -
 * showing a build with an unknown result is better than showing no build.
 */
function normaliseState(state, allowed) {
    const normalised = String(state ?? '').toLowerCase();
    return allowed.has(normalised) ? normalised : 'unknown';
}

/** A non-empty string from the payload, or the fallback. */
function optionalString(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const text = String(value).trim();
    return text || fallback;
}

/**
 * A finite number from the payload, or the fallback. `Number('abc')` is NaN,
 * which JSON serialises as `null` and Jira rejects with a schema error naming a
 * field the workflow author never set on purpose.
 */
function toNumber(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/**
 * The `url` field, if it is an absolute http(s) URL. Jira requires one on builds
 * and deployments and rejects anything relative or schemeless.
 */
function requireUrl(payload) {
    const text = optionalString(payload.url, '');
    if (!text) return undefined;

    try {
        const parsed = new URL(text);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? text : undefined;
    } catch {
        return undefined;
    }
}

function badRequest(label, reason) {
    console.warn(`Rejected ${label} report: ${reason}.`);
    return { statusCode: 400, body: `Invalid ${label} report: ${reason}` };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

async function submit(path, body, label) {
    const response = await api.asApp().requestJira(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
    });

    const responseBody = await response.text();

    if (response.ok) {
        console.log(`Submitted ${label} to Jira (status ${response.status}).`);
        return { statusCode: response.status, body: responseBody };
    }

    console.error(`Jira ${label} submission failed (${response.status}):`, responseBody);

    // Returning Jira's status verbatim makes its rejection indistinguishable
    // from a rejection of the caller's own request: a 401 from Jira's API and a
    // 401 for a bad signature look identical to the workflow that posted here,
    // and the workflow author debugs the wrong thing. 502 says what actually
    // happened - this app was reached and understood, and the service behind it
    // refused - and Jira's own words are kept in the body.
    return {
        statusCode: 502,
        body: `Jira rejected the ${label} (${response.status}): ${responseBody}`
    };
}
