import React, { useState } from "react";
import {
    Box,
    Button,
    Heading,
    Inline,
    Link,
    List,
    ListItem,
    LoadingButton,
    Lozenge,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalTitle,
    ModalTransition,
    Stack,
    Strong,
    Text,
} from "@forge/react";
import { invoke } from "@forge/bridge";

/**
 * The connected instance, and the two ways to undo it.
 *
 * Shown once authorization has succeeded, in place of the setup form - at that
 * point the question is no longer "how do I connect" but "what is connected".
 */
export const ConnectionCard = ({ connection, reload, onError }) => {
    const [busy, setBusy] = useState(null);
    const [confirmingRemove, setConfirmingRemove] = useState(false);

    /**
     * Run a resolver and re-read state, tracking which button is working so only
     * that one shows a spinner. A null `name` reloads without calling anything,
     * which is what plain Refresh needs.
     */
    const act = async (name, payload, key) => {
        setBusy(key);
        onError(null);
        try {
            if (name) await invoke(name, payload);
            await reload();
        } catch (actError) {
            onError(actError.message);
        } finally {
            setBusy(null);
        }
    };

    return (
        <Stack space="space.200">
            <Heading as="h3">Connection</Heading>

            {/*
        `elevation.surface.sunken` gives the card a visible edge. The neutral
        "subtle" token is transparent, so the card read as loose text on the page.
      */}
            <Box padding="space.200" backgroundColor="elevation.surface.sunken">
                <Stack space="space.150">
                    <Inline space="space.100" alignBlock="center">
                        <Strong>{connection.name}</Strong>
                        <Lozenge appearance="success">Authorized</Lozenge>
                        {connection.username ? (
                            <Text>as {connection.username}</Text>
                        ) : null}
                    </Inline>

                    <Link href={connection.instanceUrl} openNewTab>
                        {connection.instanceUrl}
                    </Link>

                    {/*
            `Inline` rather than `ButtonGroup`: the group stretched its children
            to fill the row, which made a plain Refresh button as wide as the
            page and pushed the destructive action to the far edge.
          */}
                    <Inline space="space.100" alignBlock="center">
                        <LoadingButton
                            appearance="primary"
                            iconBefore="refresh"
                            isLoading={busy === "reload"}
                            onClick={() => act(null, null, "reload")}
                        >
                            Refresh
                        </LoadingButton>
                        {/*
              Warning rather than danger: revoking is reversible - the
              connection and its repository selection survive, and
              re-authorizing restores it. Only removing the connection destroys
              stored state, so only that one is red.
            */}
                        <LoadingButton
                            appearance="warning"
                            iconBefore="sign-out"
                            isLoading={busy === "disconnect"}
                            onClick={() =>
                                act(
                                    "disconnect",
                                    { connectionId: connection.id },
                                    "disconnect",
                                )
                            }
                        >
                            Revoke authorization
                        </LoadingButton>
                        <Button
                            appearance="danger"
                            iconBefore="trash"
                            onClick={() => setConfirmingRemove(true)}
                        >
                            Remove connection
                        </Button>
                    </Inline>
                </Stack>
            </Box>

            {/*
        Removing a connection deletes stored credentials and asks Jira to delete
        the development data for every repository it fed. That is not recoverable
        from this page, so it is confirmed rather than fired on a single click.
      */}
            <ModalTransition>
                {confirmingRemove ? (
                    <Modal onClose={() => setConfirmingRemove(false)}>
                        <ModalHeader>
                            <ModalTitle appearance="danger">
                                Remove {connection.name}?
                            </ModalTitle>
                        </ModalHeader>
                        <ModalBody>
                            <Stack space="space.100">
                                <Text>
                                    This removes the stored credentials and
                                    access token, and:
                                </Text>
                                <List>
                                    <ListItem>
                                        <Text>
                                            deletes the webhooks this app created
                                            on {connection.repositories.length}{" "}
                                            repositor
                                            {connection.repositories.length === 1
                                                ? "y"
                                                : "ies"}
                                            ;
                                        </Text>
                                    </ListItem>
                                    <ListItem>
                                        <Text>
                                            removes their commits, branches and
                                            pull requests from the Jira
                                            development panel.
                                        </Text>
                                    </ListItem>
                                </List>
                                <Text>
                                    Jira issues themselves are not affected.
                                    Reconnecting later re-imports the history.
                                </Text>
                            </Stack>
                        </ModalBody>
                        <ModalFooter>
                            <Button
                                appearance="subtle"
                                iconBefore="cross"
                                onClick={() => setConfirmingRemove(false)}
                            >
                                Cancel
                            </Button>
                            <LoadingButton
                                appearance="danger"
                                iconBefore="trash"
                                isLoading={busy === "delete"}
                                onClick={async () => {
                                    await act(
                                        "deleteConnection",
                                        { connectionId: connection.id },
                                        "delete",
                                    );
                                    setConfirmingRemove(false);
                                }}
                            >
                                Remove connection
                            </LoadingButton>
                        </ModalFooter>
                    </Modal>
                ) : null}
            </ModalTransition>
        </Stack>
    );
};
