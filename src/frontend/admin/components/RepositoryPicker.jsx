import React, { useCallback, useState } from "react";
import {
    Button,
    DynamicTable,
    EmptyState,
    Heading,
    HelperMessage,
    Icon,
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
 * The repositories the authorizing Forgejo account can see, and the button that
 * connects one.
 */
export const RepositoryPicker = ({ connection, reload, onError, onNotice }) => {
    const [picker, setPicker] = useState(null);
    const [page, setPage] = useState(1);
    const [busyRepo, setBusyRepo] = useState(null);
    const [loading, setLoading] = useState(false);

    /**
     * Reading the repository list is a live call out to Forgejo, and on a slow or
     * unreachable instance it is the one thing on this page that can take seconds.
     * It is therefore asked for rather than run on mount: an admin who came here to
     * read the workflow file or check an import should not wait on it.
     */
    const loadPage = useCallback(
        async (requestedPage) => {
            setLoading(true);
            setPicker(null);
            try {
                setPicker(
                    await invoke("listForgejoRepositories", {
                        connectionId: connection.id,
                        page: requestedPage,
                    }),
                );
                setPage(requestedPage);
            } catch (loadError) {
                onError(loadError.message);
            } finally {
                setLoading(false);
            }
        },
        [connection.id, onError],
    );

    const connectRepo = async (repo) => {
        setBusyRepo(repo.repoId);
        onError(null);
        try {
            await invoke("connectRepository", {
                connectionId: connection.id,
                repoId: repo.repoId,
                fullName: repo.fullName,
                htmlUrl: repo.htmlUrl,
            });
            onNotice({
                text: `Connected ${repo.fullName}. Its webhook is registered and its history is importing now.`,
            });
            await Promise.all([reload(), loadPage(page)]);
        } catch (connectError) {
            onError(connectError.message);
        } finally {
            setBusyRepo(null);
        }
    };

    return (
        <Stack space="space.200">
            <Heading as="h3">Available repositories</Heading>
            <Text>
                Connecting a repository registers its webhook automatically and
                imports existing commits, branches and pull requests. You do not
                need to configure anything inside Forgejo.
            </Text>
            <HelperMessage>
                Only work that names an issue key is imported — a commit message,
                branch name or pull request title containing something like
                ABC-123.
            </HelperMessage>

            {loading ? (
                <Inline alignBlock="center" space="space.100">
                    <Spinner size="small" />
                    <Text>Reading repositories from Forgejo…</Text>
                </Inline>
            ) : !picker ? (
                <Inline>
                    <Button
                        appearance="primary"
                        iconBefore="refresh"
                        onClick={() => loadPage(1)}
                    >
                        Load repositories
                    </Button>
                </Inline>
            ) : picker.repositories.length === 0 ? (
                <EmptyState
                    header="No repositories found"
                    description="The authorizing Forgejo account cannot see any repositories."
                />
            ) : (
                <Stack space="space.150">
                    {/*
            Column widths are percentages so the status column stops drifting
            away from its rows. Only a row that can actually be acted on gets a
            button; a repository that is already connected, or that the
            authorizing account cannot administer, shows a lozenge instead. A
            disabled button reads as an action that is temporarily unavailable,
            which is the wrong story for a state that will not change by
            clicking.
          */}
                    <DynamicTable
                        head={{
                            cells: [
                                { key: "name", content: "Repository", width: 60 },
                                {
                                    key: "visibility",
                                    content: "Visibility",
                                    width: 15,
                                },
                                { key: "action", content: "Status", width: 25 },
                            ],
                        }}
                        rows={picker.repositories.map((repo) => ({
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
                                    key: "visibility",
                                    content: repo.private ? (
                                        <Icon
                                            glyph="lock-locked"
                                            label="Private"
                                            size="small"
                                        />
                                    ) : (
                                        <Icon
                                            glyph="globe"
                                            label="Public"
                                            size="small"
                                        />
                                    ),
                                },
                                {
                                    key: "action",
                                    content: repo.alreadyConnected ? (
                                        <Lozenge appearance="success">
                                            Connected
                                        </Lozenge>
                                    ) : !repo.canAdmin ? (
                                        <Lozenge appearance="default">
                                            Needs repository admin
                                        </Lozenge>
                                    ) : (
                                        <LoadingButton
                                            appearance="primary"
                                            spacing="compact"
                                            iconBefore="add"
                                            isLoading={busyRepo === repo.repoId}
                                            onClick={() => connectRepo(repo)}
                                        >
                                            Connect
                                        </LoadingButton>
                                    ),
                                },
                            ],
                        }))}
                    />

                    {/*
            Paging controls were removed at the customer's request. `hasMore` is
            still returned by the resolver, so a repository past the first page is
            reachable again the moment something is put back here.
          */}
                    {picker.hasMore ? (
                        <HelperMessage>
                            More repositories exist than are shown here.
                        </HelperMessage>
                    ) : null}
                </Stack>
            )}
        </Stack>
    );
};
