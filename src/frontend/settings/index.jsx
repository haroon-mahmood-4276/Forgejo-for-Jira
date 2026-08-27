import React, { useCallback, useEffect, useState } from "react";
import ForgeReconciler, {
    EmptyState,
    Heading,
    Inline,
    SectionMessage,
    Spinner,
    Stack,
    Text,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { ConnectedInstances } from "./components/ConnectedInstances.jsx";
import { HowWorkLinks } from "./components/HowWorkLinks.jsx";
import { SiteRepositories } from "./components/SiteRepositories.jsx";

/**
 * Project settings page.
 *
 * Development information in Jira is site-wide and matched by issue key, so a
 * project does not own a Forgejo connection - connecting an instance is done
 * once, on the site admin page. This page therefore explains what is already
 * connected and what a team has to do for their work to show up, rather than
 * offering a second place to configure the same thing.
 */
const App = () => {
    const [view, setView] = useState(null);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        try {
            setView(await invoke("getProjectView"));
        } catch (loadError) {
            setError(loadError.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    if (error) {
        return (
            <SectionMessage
                title="Could not load Forgejo status"
                appearance="error"
            >
                <Text>{error}</Text>
            </SectionMessage>
        );
    }

    if (!view) {
        return (
            <Inline alignBlock="center" space="space.100">
                <Spinner size="medium" />
                <Text>Loading…</Text>
            </Inline>
        );
    }

    // Flattened here rather than in the table, so the table renders a list and
    // does not also have to know how connections nest.
    const repositories = view.connections.flatMap((connection) =>
        connection.repositories.map((repo) => ({
            ...repo,
            connectionName: connection.name,
        })),
    );

    return (
        <Stack space="space.300">
            <Heading as="h2">Forgejo</Heading>

            {view.connections.length === 0 ? (
                <EmptyState
                    header="No Forgejo instance is connected yet"
                    description="A Jira administrator connects Forgejo once for the whole site, under Settings › Apps › Forgejo for Jira. Development data then appears on any issue whose key is referenced."
                />
            ) : (
                <Stack space="space.300">
                    <HowWorkLinks
                        projectKey={view.projectKey}
                        exampleBranch={view.exampleBranch}
                    />
                    <ConnectedInstances connections={view.connections} />
                    <SiteRepositories repositories={repositories} />
                </Stack>
            )}
        </Stack>
    );
};

ForgeReconciler.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
