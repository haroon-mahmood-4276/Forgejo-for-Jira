import React, { useCallback, useEffect, useState } from "react";
import ForgeReconciler, {
    Box,
    Heading,
    Inline,
    SectionMessage,
    Spinner,
    Stack,
    Tab,
    TabList,
    TabPanel,
    Tabs,
    Text,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { BuildsAndDeployments } from "./components/BuildsAndDeployments.jsx";
import { ChooseRepositories } from "./components/ChooseRepositories.jsx";
import { ConnectToForgejo } from "./components/ConnectToForgejo.jsx";

/**
 * Site-level admin page: "Settings > Apps > Forgejo for Jira".
 *
 * Tabs rather than a wizard. Setup does have an order - you cannot pick
 * repositories before authorizing - but this page is where an admin returns
 * months later to add a repository or re-read the workflow file, and a wizard
 * makes that a walk back through steps that are already done. The tabs are
 * always reachable; the ones whose work needs a connection say so instead of
 * pretending to be available.
 */
const App = () => {
    const [overview, setOverview] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    /**
     * Re-read everything. The fresh overview is also returned, so a caller that
     * needs to react to what changed does not have to wait a render for state to
     * settle - authorization polling uses this to say whether approval landed.
     */
    const load = useCallback(async () => {
        try {
            const next = await invoke("getOverview");
            setOverview(next);
            setError(null);
            return next;
        } catch (loadError) {
            setError(loadError.message);
            return undefined;
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    if (error && !overview) {
        return (
            <SectionMessage
                title="Could not load your Forgejo settings"
                appearance="error"
            >
                <Text>{error}</Text>
            </SectionMessage>
        );
    }

    if (!overview) {
        return (
            <Box padding="space.300">
                <Inline alignBlock="center" space="space.100">
                    <Spinner size="medium" />
                    <Text>Loading…</Text>
                </Inline>
            </Box>
        );
    }

    const connection = overview.connections[0];

    const shared = {
        connection,
        reload: load,
        onError: setError,
        onNotice: setNotice,
    };

    return (
        /*
      Page padding and rhythm come from Atlassian's spacing tokens rather than
      any hand-written CSS, so this page keeps step with the rest of Jira admin
      when the design system changes.
    */
        <Box padding="space.300">
            <Stack space="space.300">
                <Stack space="space.100">
                    <Heading as="h1">Forgejo for Jira</Heading>
                    <Text>
                        Link a self-hosted Forgejo instance to this Jira site so
                        commits, branches, pull requests, builds and deployments
                        appear on your issues.
                    </Text>
                </Stack>

                {notice ? (
                    <SectionMessage appearance={notice.appearance ?? "success"}>
                        <Text>{notice.text}</Text>
                    </SectionMessage>
                ) : null}

                {error ? (
                    <SectionMessage appearance="error">
                        <Text>{error}</Text>
                    </SectionMessage>
                ) : null}

                <Tabs id="forgejo-admin-tabs">
                    <TabList>
                        <Tab>Connect to Forgejo</Tab>
                        <Tab>Repositories</Tab>
                        <Tab>Builds &amp; deployments</Tab>
                    </TabList>

                    <TabPanel>
                        <Box paddingBlockStart="space.200">
                            <ConnectToForgejo
                                {...shared}
                                redirectUri={overview.redirectUri}
                            />
                        </Box>
                    </TabPanel>

                    <TabPanel>
                        <Box paddingBlockStart="space.200">
                            <ChooseRepositories {...shared} />
                        </Box>
                    </TabPanel>

                    <TabPanel>
                        <Box paddingBlockStart="space.200">
                            <BuildsAndDeployments
                                connection={connection}
                                onError={setError}
                            />
                        </Box>
                    </TabPanel>
                </Tabs>
            </Stack>
        </Box>
    );
};

ForgeReconciler.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
