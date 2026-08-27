import React from "react";
import { Stack, Text } from "@forge/react";
import { AuthorizeConnection } from "./AuthorizeConnection.jsx";
import { ConnectionCard } from "./ConnectionCard.jsx";
import { InstanceForm } from "./InstanceForm.jsx";

/**
 * First tab: which Forgejo instance this Jira site trusts, and whether it has
 * been authorized.
 *
 * Registering an instance and approving it are two stages of one job, and the
 * second cannot start before the first has produced a connection - so they share
 * a tab and the panel shows whichever is outstanding.
 */
export const ConnectToForgejo = ({ connection, redirectUri, reload, onError, onNotice }) => {
    if (!connection) {
        return (
            <InstanceForm
                redirectUri={redirectUri}
                reload={reload}
                onError={onError}
            />
        );
    }

    if (!connection.connected) {
        return (
            <AuthorizeConnection
                connection={connection}
                reload={reload}
                onError={onError}
                onNotice={onNotice}
            />
        );
    }

    return (
        <Stack space="space.200">
            <ConnectionCard
                connection={connection}
                reload={reload}
                onError={onError}
            />
            <Text>
                Choose which repositories feed Jira on the{" "}
                <Text as="strong">Repositories</Text> tab.
            </Text>
        </Stack>
    );
};
