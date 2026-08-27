import api, { route } from '@forge/api';
// Jira's build state enum is shared with the `workflow_run` webhook path, so the
// two routes into the builds API cannot disagree about what Jira accepts.
import { BUILD_STATES, DEPLOYMENT_STATES } from './lib/builds.js';
import { getConnectionSecrets } from './lib/storage.js';
import { extractIssueKeys } from './lib/issue-keys.js';
import { getRawBody, readSignature, verifySignature } from './lib/verify-signature.js';

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
    const connectionId = firstQueryValue(request.queryParameters, 'c');

    if (!connectionId) {
        console.warn('Rejected CI status delivery with no connection identifier.');
        return { statusCode: 400, body: 'Missing connection identifier' };
    }

    const secrets = await getConnectionSecrets(connectionId);
    if (!secrets?.webhookSecret) {
        console.warn(`Rejected CI status delivery for unknown connection ${connectionId}.`);
        return { statusCode: 404, body: 'Unknown connection' };
    }

    const rawBody = getRawBody(request);

    if (!verifySignature(rawBody, readSignature(request.headers), secrets.webhookSecret)) {
        console.warn(`Rejected CI status delivery for ${connectionId} with an invalid signature.`);
        return { statusCode: 401, body: 'Invalid signature' };
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (error) {
        console.error('CI status body was not valid JSON:', error.message);
        return { statusCode: 400, body: 'Malformed JSON body' };
    }

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
 */
function resolveIssueKeys(payload) {
    const explicit = Array.isArray(payload.issueKeys)
        ? payload.issueKeys.filter((key) => typeof key === 'string' && key.trim())
        : [];

    if (explicit.length > 0) return [...new Set(explicit.map((key) => key.trim()))];

    return extractIssueKeys(payload.ref, payload.commitMessage, payload.displayName);
}

/**
 * Submit a build result to Jira's builds API.
 */
async function submitBuild(payload, issueKeys) {
    const body = {
        builds: [
            {
                schemaVersion: '1.0',
                pipelineId: String(payload.pipelineId ?? 'forgejo-actions'),
                // Jira orders builds within a pipeline by `buildNumber`, so it has to be
                // a number rather than a string.
                buildNumber: Number(payload.buildNumber ?? 0),
                updateSequenceNumber: Date.now(),
                displayName: payload.displayName ?? `Build ${payload.buildNumber ?? ''}`.trim(),
                url: payload.url,
                state: normaliseState(payload.state, BUILD_STATES),
                lastUpdated: payload.lastUpdated ?? new Date().toISOString(),
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
    const environmentId = String(payload.environment ?? 'unmapped');

    const environmentType = normaliseEnvironmentType(environmentId);

    const sequence = Date.now();

    const body = {
        deployments: [
            {
                schemaVersion: '1.0',
                // Orders deployments to the same environment.
                deploymentSequenceNumber: Number(payload.deploymentSequenceNumber ?? sequence),
                updateSequenceNumber: sequence,
                displayName: payload.displayName ?? `Deployment to ${environmentId}`,
                url: payload.url,
                description: payload.description ?? payload.displayName ?? 'Forgejo Actions deployment',
                lastUpdated: payload.lastUpdated ?? new Date().toISOString(),
                state: normaliseState(payload.state, DEPLOYMENT_STATES),
                pipeline: {
                    id: String(payload.pipelineId ?? 'forgejo-actions'),
                    displayName: payload.pipelineId ?? 'Forgejo Actions',
                    url: payload.url
                },
                environment: {
                    id: environmentId,
                    displayName: payload.environmentName ?? environmentId,
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
    const key = String(payload.key ?? payload.id ?? '').trim();

    if (!key) {
        console.warn('Feature flag report carried no key - nothing to identify it by.');
        return { statusCode: 400, body: 'Feature flag key is required' };
    }

    const lastUpdated = payload.lastUpdated ?? new Date().toISOString();

    // Jira requires an explicit rollout only when a percentage is given; sending
    // `percentage: undefined` would fail validation, so it is built conditionally.
    const status = {
        enabled: Boolean(payload.enabled),
        defaultValue: String(payload.defaultValue ?? (payload.enabled ? 'true' : 'false')),
        ...(Number.isFinite(Number(payload.rolloutPercentage))
            ? { rollout: { percentage: Number(payload.rolloutPercentage) } }
            : {})
    };

    const body = {
        flags: [
            {
                schemaVersion: '1.0',
                // `id` is what Jira de-duplicates on; the key is the human-facing
                // name and the two are the same thing unless the caller separates
                // them.
                id: String(payload.id ?? key),
                key,
                updateSequenceId: Date.now(),
                displayName: payload.displayName ?? key,
                issueKeys,
                summary: {
                    url: payload.url,
                    status,
                    lastUpdated
                },
                details: [
                    {
                        url: payload.url,
                        lastUpdated,
                        environment: {
                            name: payload.environmentName ?? payload.environment ?? 'production',
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

function firstQueryValue(queryParameters = {}, name) {
    const value = queryParameters?.[name];
    return Array.isArray(value) ? value[0] : value;
}
