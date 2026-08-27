import api, { route } from '@forge/api';

/**
 * Authorization guards for resolver calls.
 *
 * Forge renders the admin page only for Jira administrators, but that is a UI
 * decision, not a security boundary: a resolver can be invoked directly by any
 * authenticated user of the site. Since the storage calls behind these resolvers
 * run as the app, Forge performs no implicit permission check on our behalf -
 * every mutating resolver has to ask Jira explicitly.
 *
 * Note the `route` tagged template escapes whatever is interpolated into it, so
 * query strings are written out literally and only the *values* are substituted.
 * Interpolating a whole `a=b&c=d` string would escape the separators and produce
 * a request Jira reads as one nonsense parameter.
 */

/** Throw with Jira's own failure surfaced, so a caller sees why the check failed. */
async function readPermissions(response) {
    if (!response.ok) {
        throw new Error('Could not verify your Jira permissions.');
    }
    return response.json();
}

/**
 * Require the Jira administrator global permission.
 *
 * This gates everything on the admin page: connecting a Forgejo instance decides
 * which external server this Jira site trusts with development data, which is a
 * site-wide decision.
 */
export async function requireJiraAdmin() {
    const body = await readPermissions(
        await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`)
    );

    if (body?.permissions?.ADMINISTER?.havePermission !== true) {
        throw new Error('You need Jira administrator permission to manage Forgejo connections.');
    }
}

/**
 * Require project administrator permission on a specific project.
 *
 * Used by the project settings page, which can only read status and record which
 * already-connected instance a project considers its own.
 */
export async function requireProjectAdmin(projectKey) {
    if (!projectKey) throw new Error('Missing project context.');

    const body = await readPermissions(
        await api
            .asUser()
            .requestJira(
                route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=ADMINISTER_PROJECTS`
            )
    );

    if (body?.permissions?.ADMINISTER_PROJECTS?.havePermission !== true) {
        throw new Error('You need Administer Projects permission to change this configuration.');
    }
}
