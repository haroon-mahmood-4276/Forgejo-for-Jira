import * as resolverModule from '@forge/resolver';
import { webTrigger } from '@forge/api';
import { startBackfill } from '../backfill.js';
import { deleteRepositoryEntity, devinfoRepositoryId } from '../lib/devinfo.js';
import { createClient } from '../lib/forgejo-client.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  normaliseInstanceUrl
} from '../lib/forgejo-oauth.js';
import { requireJiraAdmin } from '../lib/permissions.js';
import { resolverClass } from '../lib/resolver-class.js';
import {
  deleteConnection,
  deleteRepository,
  deleteToken,
  getConnection,
  getConnectionSecrets,
  getRepository,
  getToken,
  listConnections,
  listRepositories,
  newConnectionId,
  newWebhookSecret,
  savePendingState,
  saveConnection,
  saveConnectionSecrets,
  saveRepository
} from '../lib/storage.js';

/**
 * Backend for the site-level admin page.
 *
 * Every definition here mutates or reveals installation-wide configuration, so
 * every one of them starts with `requireJiraAdmin()`. Forge only *renders* the
 * admin page for administrators; it does not stop anyone else from invoking
 * these resolvers directly.
 */
const Resolver = resolverClass(resolverModule);
const resolver = new Resolver();

// ---------------------------------------------------------------------------
// Trigger URLs
// ---------------------------------------------------------------------------

/**
 * Web trigger URLs are generated per installation, so they are looked up at
 * runtime rather than hardcoded. The `c` parameter tells the receiving handler
 * which connection's signing secret to verify a delivery against.
 */
async function triggerUrls(connectionId) {
  const [webhookBase, ciBase, redirectUri] = await Promise.all([
    webTrigger.getUrl('forgejo-webhook-receiver'),
    webTrigger.getUrl('forgejo-ci-status-receiver'),
    webTrigger.getUrl('forgejo-oauth-callback')
  ]);

  return {
    webhookUrl: `${webhookBase}?c=${connectionId}`,
    ciStatusUrl: `${ciBase}?c=${connectionId}`,
    redirectUri
  };
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/**
 * Everything the admin page needs on load: the connections, whether each is
 * authorized, its repositories and their backfill progress.
 *
 * Assembled in one call rather than several so the page renders in a single
 * pass - a settings screen that fills in section by section reads as broken.
 */
resolver.define('getOverview', async () => {
  await requireJiraAdmin();

  const connections = await listConnections();
  const redirectUri = await webTrigger.getUrl('forgejo-oauth-callback');

  const detailed = await Promise.all(
    connections.map(async (connection) => {
      const [token, urls, repositories] = await Promise.all([
        getToken(connection.id),
        triggerUrls(connection.id),
        listRepositories(connection.id)
      ]);

      return {
        ...connection,
        // Never send the client secret or the token back to the browser; the
        // page only needs to know whether they exist.
        connected: Boolean(token?.accessToken),
        tokenExpiresAt: token?.expiresAt,
        webhookUrl: urls.webhookUrl,
        ciStatusUrl: urls.ciStatusUrl,
        repositories: repositories.map(summariseRepository)
      };
    })
  );

  return { connections: detailed, redirectUri };
});

/**
 * Flatten a stored repository record into what the page displays. The stored
 * record carries internal fields (the Forgejo hook ID) that the browser has no
 * use for.
 */
function summariseRepository(repo) {
  const backfill = repo.backfill ?? {};

  return {
    repoId: repo.repoId,
    fullName: repo.fullName,
    htmlUrl: repo.htmlUrl,
    addedAt: repo.addedAt,
    hookInstalled: Boolean(repo.hookId),
    backfillStatus: backfill.status ?? 'not started',
    backfillPhase: backfill.phase,
    backfillError: backfill.error,
    counts: backfill.counts ?? { commits: 0, branches: 0, pullRequests: 0 }
  };
}

/**
 * Reveal a connection's webhook signing secret.
 *
 * The repository webhook is created by this app, so a customer normally never
 * needs to see this. The Forgejo Actions reporter is different: the customer has
 * to store the secret in their own repository so their workflow can sign build
 * and deployment reports. Kept as a separate, explicitly-called resolver so the
 * secret is not shipped to the browser on every page load.
 */
resolver.define('revealWebhookSecret', async ({ payload }) => {
  await requireJiraAdmin();

  const secrets = await getConnectionSecrets(payload.connectionId);
  if (!secrets?.webhookSecret) throw new Error('That connection no longer exists.');

  return { webhookSecret: secrets.webhookSecret };
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a connection to a Forgejo instance.
 *
 * The webhook signing secret is generated here, once, and never shown unless
 * asked for. Generating it per connection - rather than reading a Forge
 * environment variable - is what makes this app safe to install from the
 * Marketplace: environment variables are set by the app developer and are
 * identical across every installation, so one would be a signing key shared by
 * every customer.
 */
resolver.define('createConnection', async ({ payload }) => {
  await requireJiraAdmin();

  const instanceUrl = normaliseInstanceUrl(payload.instanceUrl);
  const clientId = String(payload.clientId ?? '').trim();
  const clientSecret = String(payload.clientSecret ?? '').trim();

  if (!clientId) throw new Error('Client ID is required.');
  if (!clientSecret) throw new Error('Client secret is required.');

  // One Forgejo instance connected twice would create duplicate webhooks and
  // duplicate backfills for the same repositories.
  const existing = await listConnections();
  if (existing.some((connection) => connection.instanceUrl === instanceUrl)) {
    throw new Error('That Forgejo instance is already connected.');
  }

  const id = newConnectionId();

  await saveConnectionSecrets(id, { clientSecret, webhookSecret: newWebhookSecret() });

  const connection = {
    id,
    name: String(payload.name ?? '').trim() || new URL(instanceUrl).hostname,
    instanceUrl,
    clientId,
    createdAt: Date.now()
  };

  await saveConnection(connection);

  return { ...connection, ...(await triggerUrls(id)) };
});

/**
 * Update a connection's display name, client ID or client secret.
 *
 * The instance URL is deliberately not editable: repositories, webhooks and
 * already-submitted development data all belong to the instance it was created
 * against. Pointing an existing connection somewhere else would silently
 * mis-attribute all of it. Delete and recreate instead.
 */
resolver.define('updateConnection', async ({ payload }) => {
  await requireJiraAdmin();

  const connection = await getConnection(payload.connectionId);
  if (!connection) throw new Error('That connection no longer exists.');

  const secrets = (await getConnectionSecrets(connection.id)) ?? {};
  const clientSecret = String(payload.clientSecret ?? '').trim();

  await saveConnectionSecrets(connection.id, {
    ...secrets,
    // Blank means "keep the saved one", so an admin can change the name without
    // having to re-enter a secret they cannot read back.
    clientSecret: clientSecret || secrets.clientSecret
  });

  const updated = {
    ...connection,
    name: String(payload.name ?? '').trim() || connection.name,
    clientId: String(payload.clientId ?? '').trim() || connection.clientId
  };

  await saveConnection(updated);

  return updated;
});

/**
 * Choose which workflows are not reported as builds.
 *
 * Every Forgejo Actions run arrives on the repository webhook and becomes a
 * build. That is right for a test workflow and wrong for a deploy workflow that
 * already reports itself as a deployment: the issue would show a deployment and
 * an unrelated build for the same run, and Jira has no way to relate them.
 *
 * Stored as workflow file names, because that is what Forgejo identifies a run
 * by, and applied across the connection - a repository naming its deploy
 * workflow `deploy.yml` almost certainly means the same thing in every
 * repository on that instance.
 */
resolver.define('setBuildIgnoredWorkflows', async ({ payload }) => {
  await requireJiraAdmin();

  const connection = await getConnection(payload.connectionId);
  if (!connection) throw new Error('That connection no longer exists.');

  // Accepts either a list or the comma-separated string the admin page collects.
  const raw = Array.isArray(payload.workflows)
    ? payload.workflows
    : String(payload.workflows ?? '').split(',');

  const buildIgnoredWorkflows = [
    ...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))
  ];

  const updated = { ...connection, buildIgnoredWorkflows };
  await saveConnection(updated);

  return { buildIgnoredWorkflows };
});

/**
 * Remove a connection, its repositories and its stored credentials.
 *
 * Best effort is made to clean up on the Forgejo side too, but a Forgejo
 * instance that is unreachable or a token that is already revoked must not block
 * an admin from removing the connection from their Jira site.
 */
resolver.define('deleteConnection', async ({ payload }) => {
  await requireJiraAdmin();

  const { connectionId } = payload;
  const repositories = await listRepositories(connectionId);

  let client;
  try {
    client = await createClient(connectionId);
  } catch (error) {
    console.warn(`Removing connection ${connectionId} without Forgejo cleanup: ${error.message}`);
  }

  for (const repo of repositories) {
    if (client && repo.hookId) {
      await client.deleteWebhook(repo.owner, repo.name, repo.hookId).catch(() => {});
    }
    await deleteRepositoryEntity(devinfoRepositoryId(connectionId, repo.repoId));
  }

  await deleteConnection(connectionId);

  return { success: true, removedRepositories: repositories.length };
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Begin the OAuth flow. Returns a URL the frontend opens in a new tab.
 *
 * A UI Kit iframe cannot navigate the parent window, so the page opens this URL
 * through the bridge router and the admin approves in a normal browser tab.
 */
resolver.define('startOAuth', async ({ payload }) => {
  await requireJiraAdmin();

  const connection = await getConnection(payload.connectionId);
  if (!connection) throw new Error('That connection no longer exists.');

  const secrets = await getConnectionSecrets(connection.id);
  if (!secrets?.clientSecret) throw new Error('This connection has no stored client secret.');

  const state = createState();
  const { verifier, challenge } = createPkcePair();
  const redirectUri = await webTrigger.getUrl('forgejo-oauth-callback');

  // Everything the stateless callback needs to finish the exchange. Storing it
  // server side means the callback trusts nothing in its own URL but the state.
  await savePendingState(state, {
    connectionId: connection.id,
    instanceUrl: connection.instanceUrl,
    clientId: connection.clientId,
    clientSecret: secrets.clientSecret,
    codeVerifier: verifier,
    redirectUri
  });

  return {
    authorizeUrl: buildAuthorizeUrl({
      instanceUrl: connection.instanceUrl,
      clientId: connection.clientId,
      redirectUri,
      state,
      codeChallenge: challenge
    })
  };
});

/**
 * Forget the stored Forgejo token without discarding the connection itself, so
 * an admin can revoke access without losing their repository selection.
 */
resolver.define('disconnect', async ({ payload }) => {
  await requireJiraAdmin();

  const connection = await getConnection(payload.connectionId);
  if (connection) {
    await deleteToken(connection.id);
    await saveConnection({ ...connection, connectedAt: undefined, username: undefined });
  }

  return { success: true };
});

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/**
 * List repositories the authorizing Forgejo user can see, one page at a time,
 * flagging the ones already connected.
 */
resolver.define('listForgejoRepositories', async ({ payload }) => {
  await requireJiraAdmin();

  const client = await createClient(payload.connectionId);
  const page = Number(payload.page ?? 1);

  const { items, hasMore } = await client.listRepositories(page);
  const connected = new Set(
    (await listRepositories(payload.connectionId)).map((repo) => String(repo.repoId))
  );

  return {
    page,
    hasMore,
    repositories: items.map((repo) => ({
      repoId: String(repo.id),
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      description: repo.description || undefined,
      private: Boolean(repo.private),
      // Creating the webhook needs admin rights on the repository; showing this
      // up front is kinder than letting the connect attempt fail.
      canAdmin: repo.permissions?.admin === true,
      alreadyConnected: connected.has(String(repo.id))
    }))
  };
});

/**
 * Connect a repository.
 *
 * Three things happen, in this order:
 *
 *  1. The webhook is created on Forgejo, so live events start flowing. This is
 *     done first because it is the step that can fail on permissions, and
 *     failing before anything is stored leaves no half-connected record behind.
 *  2. The repository record is stored.
 *  3. A backfill is queued, so existing issues get their history rather than
 *     only showing work done from this moment on.
 */
resolver.define('connectRepository', async ({ payload }) => {
  await requireJiraAdmin();

  const { connectionId, repoId, fullName } = payload;

  const [owner, name] = String(fullName).split('/');
  if (!owner || !name) throw new Error(`Unrecognised repository name: ${fullName}`);

  const existing = await getRepository(connectionId, repoId);
  if (existing) throw new Error(`${fullName} is already connected.`);

  const client = await createClient(connectionId);
  const secrets = await getConnectionSecrets(connectionId);
  const { webhookUrl } = await triggerUrls(connectionId);

  const hook = await client.createWebhook(owner, name, {
    url: webhookUrl,
    secret: secrets.webhookSecret
  });

  const repository = await client.getRepository(owner, name);

  await saveRepository({
    connectionId,
    repoId: String(repoId),
    fullName,
    owner,
    name,
    htmlUrl: repository?.html_url ?? payload.htmlUrl,
    // Needed to offer a "create pull request" action on each branch: Forgejo's
    // compare URL requires an explicit base, and nothing in the branch listing or
    // the webhook payload carries it.
    defaultBranch: repository?.default_branch,
    hookId: hook?.id,
    addedAt: Date.now()
  });

  const { jobId } = await startBackfill(connectionId, repoId);

  console.log(`Connected ${fullName} and queued backfill job ${jobId}.`);

  return { success: true, jobId };
});

/**
 * Disconnect a repository: remove the Forgejo webhook, drop the stored record,
 * and remove the repository from Jira's development panel so the customer stops
 * seeing data they just asked to stop receiving.
 */
resolver.define('disconnectRepository', async ({ payload }) => {
  await requireJiraAdmin();

  const { connectionId, repoId } = payload;

  const repo = await getRepository(connectionId, repoId);
  if (!repo) return { success: true };

  try {
    const client = await createClient(connectionId);
    if (repo.hookId) await client.deleteWebhook(repo.owner, repo.name, repo.hookId);
  } catch (error) {
    // An unreachable Forgejo must not trap the repository in a connected state.
    console.warn(`Could not remove the Forgejo webhook for ${repo.fullName}: ${error.message}`);
  }

  await deleteRepositoryEntity(devinfoRepositoryId(connectionId, repoId));
  await deleteRepository(connectionId, repoId);

  return { success: true };
});

/**
 * Re-run the historical import for one repository. Useful after the app has been
 * offline, or when a repository was connected before its issue keys existed.
 */
resolver.define('resyncRepository', async ({ payload }) => {
  await requireJiraAdmin();
  return startBackfill(payload.connectionId, payload.repoId);
});

// ---------------------------------------------------------------------------
// Forgejo Actions workflow
// ---------------------------------------------------------------------------

/**
 * Produce a ready-to-paste Forgejo Actions workflow that reports deployments.
 *
 * It deliberately does not report builds. Forgejo's `workflow_run` webhook
 * already reports every run, so a workflow that also posted a build would put two
 * build entities on the issue under two different pipeline identifiers.
 *
 * Handing over a working file matters: this is the one part of setup the app
 * cannot do on the customer's behalf, because it means committing a file to
 * their repository. Everything in it that is installation-specific - the URL -
 * is filled in here; the one secret is referenced by name so it never has to be
 * committed.
 */
resolver.define('getWorkflowSnippet', async ({ payload }) => {
  await requireJiraAdmin();

  const { ciStatusUrl } = await triggerUrls(payload.connectionId);

  return { ciStatusUrl, workflow: workflowYaml(ciStatusUrl) };
});

function workflowYaml(ciStatusUrl) {
  return `# .forgejo/workflows/jira.yml
#
# Reports deployments to Jira: "in progress" when the job starts, then the real
# result when it ends.
#
# Builds are NOT reported here. Forgejo emits a workflow_run webhook on every run
# and the repository webhook this app registered already turns those into build
# entities, so reporting a build here too would show two builds per run.
#
# Before using it, add a repository secret named JIRA_FORGEJO_SECRET holding the
# webhook secret shown in Jira under Settings > Apps > Forgejo for Jira.
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: docker
    env:
      JIRA_URL: ${ciStatusUrl}
      JIRA_SECRET: \${{ secrets.JIRA_FORGEJO_SECRET }}
      ENVIRONMENT: production
      # Jira treats a deployment as the same deployment when this number, the
      # pipeline and the environment all match, so start and finish must share
      # it or you get two rows instead of one that updates.
      RUN_NUMBER: \${{ github.run_number }}
      RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_number }}
      # The issue key is read from the branch name and the commit subject, so
      # nothing else is needed from the workflow author. Both go through env
      # rather than being interpolated into the shell: a branch or commit
      # subject is attacker-controlled text.
      REF: \${{ github.ref_name }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Install the reporter
        run: |
          command -v jq >/dev/null && command -v openssl >/dev/null || {
            apt-get update -qq && apt-get install -y -qq jq openssl
          }

          cat > /tmp/jira-report.sh <<'SCRIPT'
          #!/bin/sh
          set -eu

          BODY=$(jq -nc \\
            --arg state "$JIRA_STATE" \\
            --arg env "$ENVIRONMENT" \\
            --arg ref "$REF" \\
            --arg msg "$COMMIT_MSG" \\
            --arg url "$RUN_URL" \\
            --argjson seq "$RUN_NUMBER" \\
            '{type:"deployment", state:$state, environment:$env, ref:$ref,
              commitMessage:$msg, url:$url,
              displayName:("Deploy to " + $env),
              deploymentSequenceNumber:$seq, pipelineId:"deploy"}')

          # The signature is an HMAC-SHA256 of the exact bytes being sent.
          SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$JIRA_SECRET" -hex | sed 's/^.* //')

          # curl exits 0 on 4xx and 5xx, so a rejected report would look like a
          # green step. Read the status back and fail on anything but 2xx.
          CODE=$(curl -sS -o /tmp/jira-response.txt -w '%{http_code}' -X POST "$JIRA_URL" \\
            -H 'Content-Type: application/json' \\
            -H "X-Forgejo-Signature: $SIG" \\
            --data-raw "$BODY")

          echo "Jira responded $CODE: $(cat /tmp/jira-response.txt)"
          case "$CODE" in
            2*) ;;
            *) echo "Jira rejected the deployment report."; exit 1 ;;
          esac
          SCRIPT
          chmod +x /tmp/jira-report.sh

      - name: Tell Jira the deployment started
        env:
          JIRA_STATE: in_progress
          COMMIT_MSG: \${{ github.event.head_commit.message }}
        run: /tmp/jira-report.sh

      # ---- your own deployment steps go here ----

      - name: Tell Jira how the deployment ended
        if: always()
        env:
          JOB_STATUS: \${{ job.status }}
          COMMIT_MSG: \${{ github.event.head_commit.message }}
        run: |
          # Jira's states are not Forgejo's: "success" is not a state Jira knows,
          # so an unmapped value would arrive as "unknown".
          case "$JOB_STATUS" in
            success)   JIRA_STATE=successful ;;
            cancelled) JIRA_STATE=cancelled ;;
            *)         JIRA_STATE=failed ;;
          esac
          export JIRA_STATE
          /tmp/jira-report.sh

# Valid environments: development, testing, staging, production.
#
# To report a feature flag, post the same way with:
#   {"type":"featureFlag", "key":"checkout-v2", "displayName":"Checkout v2",
#    "enabled":true, "rolloutPercentage":25, "environment":"production",
#    "url":"...", "ref":"...", "commitMessage":"..."}
# Forgejo has no flags of its own, so this is for reporting whatever flag system
# you already use. Omit rolloutPercentage if the flag is simply on or off.
`;
}

export const handler = resolver.getDefinitions();
