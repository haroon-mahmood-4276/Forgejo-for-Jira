import React, { useEffect, useState } from "react";
import {
    DynamicTable,
    Heading,
    Inline,
    Link,
    LoadingButton,
    Lozenge,
    Spinner,
    Stack,
    Text,
} from "@forge/react";
import { invoke } from "@forge/bridge";

/**
 * Stop refreshing import progress after 20 minutes.
 *
 * A repository whose status never leaves "queued" - because the work failed to
 * enqueue at all - would otherwise have this page calling the backend every five
 * seconds for as long as the tab stayed open.
 */
const MAX_PROGRESS_POLLS = 240;

/**
 * The repositories already feeding Jira, with how their history import is going.
 */
export const ConnectedRepositories = ({ connection, reload, onError }) => {
    const [busy, setBusy] = useState(null);
    const [pollsSpent, setPollsSpent] = useState(0);

    const act = async (name, payload, key) => {
        setBusy(key);
        onError(null);
        try {
            await invoke(name, payload);
            await reload();
        } catch (actError) {
            onError(actError.message);
        } finally {
            setBusy(null);
        }
    };

    /**
     * Keep the import progress live.
     *
     * Backfill runs in the background across many invocations, so the counts on
     * screen go stale the instant they are rendered. Polling only while something
     * is actually in flight means a settled page makes no requests at all.
     */
    const importing = connection.repositories.some((repo) =>
        ["queued", "running"].includes(repo.backfillStatus),
    );

    useEffect(() => {
        if (!importing || pollsSpent >= MAX_PROGRESS_POLLS) return undefined;

        const timer = setInterval(() => {
            setPollsSpent((spent) => spent + 1);
            reload();
        }, 5000);

        return () => clearInterval(timer);
    }, [importing, pollsSpent, reload]);

    if (connection.repositories.length === 0) return null;

    return (
        <Stack space="space.100">
            <Heading as="h3">Connected repositories</Heading>
            <DynamicTable
                head={{
                    cells: [
                        { key: "name", content: "Repository", width: 35 },
                        { key: "import", content: "History import", width: 20 },
                        { key: "found", content: "Linked to issues", width: 25 },
                        { key: "action", content: "Actions", width: 20 },
                    ],
                }}
                rows={connection.repositories.map((repo) => {
                    // Re-importing a repository mid-import restarts the phase
                    // machine underneath the jobs already queued, and removing one
                    // leaves those jobs pointing at a record that no longer exists.
                    // Neither is recoverable from the page, so both are refused
                    // until the import settles. The backend applies the same rule
                    // and additionally lets a stalled import through after an
                    // hour, so an import that never finishes is not stuck forever.
                    const midImport =
                        ["queued", "running"].includes(repo.backfillStatus) &&
                        !repo.backfillStale;

                    return {
                    key: repo.repoId,
                    cells: [
                        {
                            key: "name",
                            content: (
                                <Link href={repo.htmlUrl} openNewTab>
                                    {repo.fullName}
                                </Link>
                            ),
                        },
                        {
                            key: "import",
                            content: <BackfillStatus repo={repo} />,
                        },
                        {
                            key: "found",
                            content: (
                                <Text>
                                    {repo.counts.commits} commits ·{" "}
                                    {repo.counts.branches} branches ·{" "}
                                    {repo.counts.pullRequests} pull requests
                                </Text>
                            ),
                        },
                        {
                            key: "action",
                            content: (
                                <Inline space="space.050" alignBlock="center">
                                    <LoadingButton
                                        appearance="primary"
                                        spacing="compact"
                                        iconBefore="refresh"
                                        isLoading={
                                            busy === `sync-${repo.repoId}`
                                        }
                                        isDisabled={midImport}
                                        onClick={() =>
                                            act(
                                                "resyncRepository",
                                                {
                                                    connectionId: connection.id,
                                                    repoId: repo.repoId,
                                                },
                                                `sync-${repo.repoId}`,
                                            )
                                        }
                                    >
                                        Re-import
                                    </LoadingButton>
                                    <LoadingButton
                                        appearance="danger"
                                        spacing="compact"
                                        iconBefore="trash"
                                        isLoading={
                                            busy === `remove-${repo.repoId}`
                                        }
                                        isDisabled={midImport}
                                        onClick={() =>
                                            act(
                                                "disconnectRepository",
                                                {
                                                    connectionId: connection.id,
                                                    repoId: repo.repoId,
                                                },
                                                `remove-${repo.repoId}`,
                                            )
                                        }
                                    >
                                        Remove
                                    </LoadingButton>
                                </Inline>
                            ),
                        },
                    ],
                    };
                })}
            />
        </Stack>
    );
};

/**
 * Backfill runs in the background across many invocations, so the admin needs to
 * be able to tell "still working" apart from "finished" and from "stuck".
 */
const BackfillStatus = ({ repo }) => {
    if (repo.backfillStatus === "complete")
        return <Lozenge appearance="success">Complete</Lozenge>;

    if (repo.backfillStatus === "failed") {
        return (
            <Stack space="space.050">
                <Lozenge appearance="removed">Failed</Lozenge>
                {repo.backfillError ? <Text>{repo.backfillError}</Text> : null}
            </Stack>
        );
    }

    if (repo.backfillStatus === "running" || repo.backfillStatus === "queued") {
        const phase = repo.backfillPhase === "pullRequests" ? "pull requests" : repo.backfillPhase ?? "";
        return (
            <Inline space="space.075" alignBlock="center">
                <Spinner size="small" />
                <Text>Importing {phase}…</Text>
            </Inline>
        );
    }

    return <Lozenge>Not started</Lozenge>;
};
