/**
 * Jira issue keys look like ABC-123: an uppercase project key (a letter, then
 * letters or digits) followed by a hyphen and the issue number.
 */
export const ISSUE_KEY_PATTERN = /[A-Z][A-Z0-9]+-\d+/g;

/** The same shape, anchored, for validating a value that claims to be one key. */
const WHOLE_ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * Whether a string is exactly one issue key - used to validate keys a caller
 * supplies explicitly, so nothing that is not an issue key is forwarded as one.
 */
export function isIssueKey(value) {
    return typeof value === 'string' && WHOLE_ISSUE_KEY.test(value);
}

/**
 * Extract unique Jira issue keys from one or more strings.
 *
 * Callers pass *specific fields* - a commit message, a branch name, a pull
 * request title - never the whole payload. Scanning a stringified payload would
 * match issue-key-shaped text inside repository names, clone URLs and unrelated
 * branch names, and would attach development data to issues nobody referenced.
 */
export function extractIssueKeys(...texts) {
    const keys = new Set();

    for (const text of texts) {
        if (text === undefined || text === null) continue;
        for (const match of String(text).match(ISSUE_KEY_PATTERN) || []) {
            keys.add(match);
        }
    }

    return [...keys];
}
