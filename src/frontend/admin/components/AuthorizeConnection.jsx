import React, { useEffect, useState } from "react";
import {
    Heading,
    HelperMessage,
    Inline,
    LoadingButton,
    SectionMessage,
    Spinner,
    Stack,
    Strong,
    Text,
} from "@forge/react";
import { invoke, router } from "@forge/bridge";

/** Stop polling for approval after five minutes. */
const APPROVAL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Approve the OAuth application and store the resulting token.
 *
 * Approval happens in a separate browser tab and finishes at the OAuth callback,
 * which has no way to reach back into this iframe. So once the approval tab is
 * open this polls until the token appears, rather than asking the admin to tell
 * the page what they just did.
 */
export const AuthorizeConnection = ({
    connection,
    reload,
    onError,
    onNotice,
}) => {
    const [busy, setBusy] = useState(false);
    const [checking, setChecking] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [opened, setOpened] = useState(false);
    const [gaveUp, setGaveUp] = useState(false);

    useEffect(() => {
        if (!opened || gaveUp) return undefined;

        const deadline = Date.now() + APPROVAL_WINDOW_MS;
        let stopped = false;

        const timer = setInterval(async () => {
            if (stopped) return;

            if (Date.now() > deadline) {
                setGaveUp(true);
                return;
            }

            const fresh = (await reload())?.connections?.[0];

            if (fresh?.connected && !stopped) {
                onNotice({
                    text: `Authorized as ${fresh.username}. Choose your repositories next.`,
                });
            }
        }, 3000);

        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [opened, gaveUp, reload, onNotice]);

    /**
     * Manual fallback, for when the poll has given up or the admin approved in a
     * tab this page never opened. Reporting the outcome matters as much as the
     * reload: if nothing on screen changes, the button looks broken when in fact
     * the answer was "still not authorized".
     */
    const recheck = async () => {
        setChecking(true);
        onError(null);
        try {
            const fresh = (await reload())?.connections?.[0];

            onNotice(
                fresh?.connected
                    ? {
                          text: `Authorized as ${fresh.username}. Choose your repositories next.`,
                      }
                    : {
                          appearance: "information",
                          text: "Still not authorized. Finish approving in the Forgejo tab, then check again.",
                      },
            );
        } finally {
            setChecking(false);
        }
    };

    const remove = async () => {
        setRemoving(true);
        onError(null);
        try {
            await invoke("deleteConnection", { connectionId: connection.id });
            onNotice(null);
            await reload();
        } catch (removeError) {
            onError(removeError.message);
        } finally {
            setRemoving(false);
        }
    };

    const connect = async () => {
        setBusy(true);
        onError(null);
        try {
            const { authorizeUrl } = await invoke("startOAuth", {
                connectionId: connection.id,
            });
            // A UI Kit iframe cannot navigate the parent window, so the approval
            // page is opened through the bridge router instead.
            await router.open(authorizeUrl);
            setOpened(true);
        } catch (connectError) {
            onError(connectError.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Stack space="space.200">
            <Heading as="h3">Authorize access to {connection.name}</Heading>
            <Text>
                Approving the OAuth application lets this app read your
                repositories, register webhooks and import history. Approval
                opens in a new browser tab.
            </Text>

            {opened && !gaveUp ? (
                <SectionMessage appearance="information">
                    <Inline space="space.100" alignBlock="center">
                        <Spinner size="small" />
                        <Text>
                            Waiting for you to approve access in the other tab.
                            This page updates itself the moment you do — you can
                            close that tab afterwards.
                        </Text>
                    </Inline>
                </SectionMessage>
            ) : null}

            {gaveUp ? (
                <SectionMessage appearance="warning">
                    <Text>
                        Stopped waiting after five minutes. If you have since
                        approved access, choose <Strong>Check now</Strong>.
                    </Text>
                </SectionMessage>
            ) : null}

            <Inline space="space.100" alignBlock="center">
                <LoadingButton
                    appearance="primary"
                    iconBefore="sign-in"
                    onClick={connect}
                    isLoading={busy}
                >
                    Authorize with Forgejo
                </LoadingButton>

                {/*
          Re-reading state is the only way to notice that approval finished, as
          it happens in a different tab. The button says what it is for rather
          than "Refresh", and reports back either way - a button that reloads
          unchanged state looks broken otherwise.
        */}
                <LoadingButton
                    iconBefore="refresh"
                    onClick={recheck}
                    isLoading={checking}
                >
                    Check now
                </LoadingButton>
            </Inline>

            <Stack space="space.050">
                <HelperMessage>
                    Wrong instance or credentials? Remove the connection and
                    start again.
                </HelperMessage>
                <Inline>
                    <LoadingButton
                        appearance="danger"
                        spacing="compact"
                        iconBefore="trash"
                        isLoading={removing}
                        onClick={remove}
                    >
                        Remove connection
                    </LoadingButton>
                </Inline>
            </Stack>
        </Stack>
    );
};
