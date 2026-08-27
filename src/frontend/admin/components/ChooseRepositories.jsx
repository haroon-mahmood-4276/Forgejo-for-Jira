import React from "react";
import { Stack } from "@forge/react";
import { ConnectedRepositories } from "./ConnectedRepositories.jsx";
import { NeedsConnection } from "./NeedsConnection.jsx";
import { RepositoryPicker } from "./RepositoryPicker.jsx";

/**
 * Second tab: which repositories feed Jira.
 *
 * What is already connected comes first, because on any visit after the first
 * that is what the admin came to check.
 */
export const ChooseRepositories = ({ connection, reload, onError, onNotice }) => {
    if (!connection?.connected) return <NeedsConnection />;

    return (
        <Stack space="space.200">
            <ConnectedRepositories
                connection={connection}
                reload={reload}
                onError={onError}
            />
            <RepositoryPicker
                connection={connection}
                reload={reload}
                onError={onError}
                onNotice={onNotice}
            />
        </Stack>
    );
};
