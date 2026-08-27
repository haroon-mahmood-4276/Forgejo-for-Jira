import * as resolverModule from '@forge/resolver';
import { requireProjectAdmin } from '../lib/permissions.js';
import { resolverClass } from '../lib/resolver-class.js';
import { getProjectLink, listConnections, listRepositories, saveProjectLink } from '../lib/storage.js';

/**
 * Backend for the project settings page.
 *
 * This page is informational by design. Development information in Jira is
 * site-wide and matched by issue key, so a project does not own a Forgejo
 * connection and cannot meaningfully have its own - connecting an instance is a
 * site-level decision made on the admin page.
 *
 * What a project admin can do here is see which instance and repositories feed
 * their project's issues, and record which connection they consider theirs so
 * the page shows the relevant one first.
 */
const Resolver = resolverClass(resolverModule);
const resolver = new Resolver();

resolver.define('getProjectView', async ({ context }) => {
  const projectKey = context?.extension?.project?.key;
  if (!projectKey) throw new Error('Missing project context.');

  const [connections, link] = await Promise.all([listConnections(), getProjectLink(projectKey)]);

  const detailed = await Promise.all(
    connections.map(async (connection) => ({
      id: connection.id,
      name: connection.name,
      instanceUrl: connection.instanceUrl,
      connected: Boolean(connection.connectedAt),
      username: connection.username,
      repositories: (await listRepositories(connection.id)).map((repo) => ({
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        backfillStatus: repo.backfill?.status ?? 'not started',
        counts: repo.backfill?.counts ?? { commits: 0, branches: 0, pullRequests: 0 }
      }))
    }))
  );

  return {
    projectKey,
    connections: detailed,
    selectedConnectionId: link?.connectionId,
    // Shown as an example so the page can spell out the convention without the
    // reader having to know it already.
    exampleBranch: `${projectKey}-123-short-description`
  };
});

/**
 * Record which connection this project considers its own.
 *
 * Guarded even though it changes nothing outside the project: a resolver is
 * reachable by any authenticated user of the site, not only by whoever Jira
 * chose to render the page for.
 */
resolver.define('setProjectConnection', async ({ payload, context }) => {
  const projectKey = context?.extension?.project?.key;
  await requireProjectAdmin(projectKey);

  await saveProjectLink(projectKey, payload.connectionId);

  return { success: true };
});

export const handler = resolver.getDefinitions();
