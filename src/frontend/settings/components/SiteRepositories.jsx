import React from "react";
import {
    DynamicTable,
    Heading,
    HelperMessage,
    Link,
    Lozenge,
    Stack,
    Text,
} from "@forge/react";

/**
 * Every repository feeding this Jira site.
 *
 * Deliberately not filtered to this project: development data is matched by
 * issue key across the whole site, so a repository that looks unrelated may
 * still be the one carrying this project's commits.
 */
export const SiteRepositories = ({ repositories }) => (
    <Stack space="space.100">
        <Heading as="h3">Repositories feeding this site</Heading>

        {repositories.length === 0 ? (
            <HelperMessage>
                No repositories are connected yet. A Jira administrator adds them
                under Settings › Apps › Forgejo for Jira.
            </HelperMessage>
        ) : (
            <DynamicTable
                head={{
                    cells: [
                        { key: "name", content: "Repository" },
                        { key: "instance", content: "Instance" },
                        { key: "import", content: "History import" },
                    ],
                }}
                rows={repositories.map((repo) => ({
                    key: repo.fullName,
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
                            key: "instance",
                            content: <Text>{repo.connectionName}</Text>,
                        },
                        {
                            key: "import",
                            content:
                                repo.backfillStatus === "complete" ? (
                                    <Lozenge appearance="success">
                                        Complete
                                    </Lozenge>
                                ) : (
                                    <Lozenge>{repo.backfillStatus}</Lozenge>
                                ),
                        },
                    ],
                }))}
            />
        )}
    </Stack>
);
