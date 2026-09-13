import * as resolverModule from '@forge/resolver';
import { webTrigger } from '@forge/api';
import { isImportStale, startBackfill } from '../backfill.js';
import { isConnectionId } from '../lib/delivery.js';
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
// Input handling
// ---------------------------------------------------------------------------

/**
 * Resolve the connection a payload names, or throw.
 *
 * Every resolver below acts on one connection, and every one of them has to
 * refuse the same two things: an identifier that is not shaped like one, and
 * one that names nothing. Checking the shape first keeps arbitrary strings out
 * of storage keys.
 */
async function requireConnection(payload) {
  const connectionId = String(payload?.connectionId ?? '');
  if (!isConnectionId(connectionId)) throw new Error('Invalid connection identifier.');

  const connection = await getConnection(connectionId);
  if (!connection) throw new Error('That connection no longer exists.');

  return connection;
}

/** Forgejo repository ids are positive integers; anything else names no repository. */
function requireRepoId(value) {
  const repoId = String(value ?? '').trim();
  if (!/^[0-9]{1,18}$/.test(repoId)) throw new Error('Invalid repository identifier.');
  return repoId;
}

/** Trim a free-text field and cap its length, so a stored record stays small. */
function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Trigger URLs
// ---------------------------------------------------------------------------

/**
 * Web trigger URLs are generated per installation, so they are looked up at
 * runtime rather than hardcoded. The `c` parameter tells the receiving handler
 * which connection's signing secret to verify a delivery against.
 */
async function triggerUrls(connectionId) {
  const [webhookBase, ciBase] = await Promise.all([
    webTrigger.getUrl('forgejo-webhook-receiver'),
    webTrigger.getUrl('forgejo-ci-status-receiver')
  ]);

  return {
    webhookUrl: `${webhookBase}?c=${connectionId}`,
    ciStatusUrl: `${ciBase}?c=${connectionId}`
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
      const [token, repositories] = await Promise.all([
        getToken(connection.id),
        listRepositories(connection.id)
      ]);

      return {
        ...connection,
        // Never send the client secret or the token back to the browser; the
        // page only needs to know whether they exist.
        connected: Boolean(token?.accessToken),
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
    backfillStatus: backfill.status ?? 'not started',
    backfillPhase: backfill.phase,
    backfillError: backfill.error,
    // An import that has made no progress for an hour may be restarted; the page
    // re-enables its buttons on this rather than reimplementing the rule.
    backfillStale: isImportStale(backfill),
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

  const connection = await requireConnection(payload);
  const secrets = await getConnectionSecrets(connection.id);
  if (!secrets?.webhookSecret) throw new Error('That connection has no signing secret.');

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
  const clientId = text(payload.clientId, 500);
  const clientSecret = text(payload.clientSecret, 2000);

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
    name: text(payload.name, 100) || new URL(instanceUrl).hostname,
    instanceUrl,
    clientId,
    createdAt: Date.now()
  };

  await saveConnection(connection);

  return connection;
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

  const connection = await requireConnection(payload);

  // Accepts either a list or the comma-separated string the admin page collects.
  const raw = Array.isArray(payload.workflows)
    ? payload.workflows
    : String(payload.workflows ?? '').split(',');

  const buildIgnoredWorkflows = [
    ...new Set(raw.map((entry) => text(entry, 200)).filter(Boolean))
  ].slice(0, 100);

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

  const { id: connectionId } = await requireConnection(payload);
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

  const connection = await requireConnection(payload);

  const secrets = await getConnectionSecrets(connection.id);
  if (!secrets?.clientSecret) throw new Error('This connection has no stored client secret.');

  const state = createState();
  const { verifier, challenge } = createPkcePair();
  const redirectUri = await webTrigger.getUrl('forgejo-oauth-callback');

  // Everything the stateless callback needs to finish the exchange. Storing it
  // server side means the callback trusts nothing in its own URL but the state.
  // The client secret is deliberately not copied here: the callback reads it
  // from the connection's own secret record, so it lives in one place.
  await savePendingState(state, {
    connectionId: connection.id,
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

  const connection = await requireConnection(payload);
  await deleteToken(connection.id);
  await saveConnection({ ...connection, connectedAt: undefined, username: undefined });

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

  const connection = await requireConnection(payload);
  const client = await createClient(connection.id);

  const requested = Number(payload.page ?? 1);
  const page = Number.isInteger(requested) && requested >= 1 ? requested : 1;

  const { items, hasMore } = await client.listRepositories(page);
  const connected = new Set(
    (await listRepositories(connection.id)).map((repo) => String(repo.repoId))
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

  const connection = await requireConnection(payload);
  const connectionId = connection.id;
  const requestedRepoId = requireRepoId(payload.repoId);

  const [owner, name] = String(payload.fullName ?? '').split('/');
  if (!owner || !name) throw new Error(`Unrecognised repository name: ${payload.fullName}`);

  const existing = await getRepository(connectionId, requestedRepoId);
  if (existing) throw new Error(`${existing.fullName} is already connected.`);

  const client = await createClient(connectionId);

  // The repository's identity is taken from Forgejo, not from the browser. The
  // id is what Jira files development data under and what every later webhook
  // is matched against, so it has to be the one Forgejo actually assigned to
  // the repository the admin named.
  const repository = await client.getRepository(owner, name);
  const repoId = String(repository?.id ?? '');
  if (repoId !== requestedRepoId) {
    throw new Error(`${owner}/${name} is not the repository that was selected. Reload the list.`);
  }

  // Creating a webhook needs admin rights on the repository. Forgejo would
  // refuse anyway, but its 403 says less than this does.
  if (repository.permissions && repository.permissions.admin !== true) {
    throw new Error(`The authorizing account cannot administer ${owner}/${name}.`);
  }

  const secrets = await getConnectionSecrets(connectionId);
  const { webhookUrl } = await triggerUrls(connectionId);

  // A hook left behind by an earlier connect - the record was removed but the
  // Forgejo side could not be reached - would deliver every event twice if a
  // second one were created next to it, so an existing one is adopted.
  const hook =
    (await client.findWebhook(owner, name, webhookUrl)) ??
    (await client.createWebhook(owner, name, {
      url: webhookUrl,
      secret: secrets.webhookSecret
    }));

  await saveRepository({
    connectionId,
    repoId,
    fullName: repository.full_name ?? `${owner}/${name}`,
    owner: repository.owner?.login ?? owner,
    name: repository.name ?? name,
    htmlUrl: repository.html_url,
    // Needed to offer a "create pull request" action on each branch: Forgejo's
    // compare URL requires an explicit base, and nothing in the branch listing or
    // the webhook payload carries it.
    defaultBranch: repository.default_branch,
    hookId: hook?.id,
    addedAt: Date.now()
  });

  const { jobId } = await startBackfill(connectionId, repoId);

  console.log(`Connected ${repository.full_name} and queued backfill job ${jobId}.`);

  return { success: true, jobId };
});

/**
 * Disconnect a repository: remove the Forgejo webhook, drop the stored record,
 * and remove the repository from Jira's development panel so the customer stops
 * seeing data they just asked to stop receiving.
 */
resolver.define('disconnectRepository', async ({ payload }) => {
  await requireJiraAdmin();

  const { id: connectionId } = await requireConnection(payload);
  const repoId = requireRepoId(payload.repoId);

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

  const { id: connectionId } = await requireConnection(payload);
  return startBackfill(connectionId, requireRepoId(payload.repoId));
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

  const connection = await requireConnection(payload);
  const { ciStatusUrl } = await triggerUrls(connection.id);

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
