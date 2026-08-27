import React, { useState } from "react";
import {
    Button,
    Code,
    CodeBlock,
    Heading,
    HelperMessage,
    Inline,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalTitle,
    ModalTransition,
    Label,
    Stack,
    Strong,
    Text,
    Textfield,
} from "@forge/react";
import { invoke } from "@forge/bridge";
import { NeedsConnection } from "./NeedsConnection.jsx";

/**
 * Third tab: reporting build and deployment results.
 *
 * Builds need nothing here: Forgejo emits a `workflow_run` webhook and the
 * repository webhook the app already registered reports those. Deployments have
 * no Forgejo equivalent to read, so they are the one thing the app cannot do on
 * the customer's behalf - it means committing a workflow file to their
 * repository. The page generates that file with the trigger URL already filled
 * in, and reveals the signing secret on request.
 */
export const BuildsAndDeployments = ({ connection, onError }) => {
    const [snippet, setSnippet] = useState(null);
    const [secret, setSecret] = useState(null);
    const [open, setOpen] = useState(false);
    const [ignored, setIgnored] = useState(
        (connection?.buildIgnoredWorkflows ?? []).join(", "),
    );
    const [saved, setSaved] = useState(false);

    if (!connection?.connected) return <NeedsConnection />;

    const saveIgnored = async () => {
        onError(null);
        setSaved(false);
        try {
            const result = await invoke("setBuildIgnoredWorkflows", {
                connectionId: connection.id,
                workflows: ignored,
            });
            setIgnored((result.buildIgnoredWorkflows ?? []).join(", "));
            setSaved(true);
        } catch (saveError) {
            onError(saveError.message);
        }
    };

    const show = async () => {
        onError(null);
        try {
            setSnippet(
                await invoke("getWorkflowSnippet", {
                    connectionId: connection.id,
                }),
            );
            setOpen(true);
        } catch (showError) {
            onError(showError.message);
        }
    };

    const reveal = async () => {
        try {
            const { webhookSecret } = await invoke("revealWebhookSecret", {
                connectionId: connection.id,
            });
            setSecret(webhookSecret);
        } catch (revealError) {
            onError(revealError.message);
        }
    };

    return (
        <Stack space="space.200">
            <Heading as="h3">Builds and deployments</Heading>
            <Text>
                Commits, branches, pull requests and builds work with no further
                setup — a Forgejo Actions run arrives on the same webhook when it
                finishes and appears on your issues as a build. Deployments need
                one extra step: Forgejo has nothing to read for them, so a step
                in your own workflow reports them instead.
            </Text>

            <Inline space="space.100" alignBlock="center">
                <Button iconBefore="document" onClick={show}>
                    Show workflow file
                </Button>
            </Inline>
            <HelperMessage>
                Optional. Skipping this changes nothing else — commits, branches
                and pull requests keep working either way.
            </HelperMessage>

            <Stack space="space.050">
                <Label labelFor="build-ignored-workflows">
                    Workflows not reported as builds
                </Label>
                <Textfield
                    id="build-ignored-workflows"
                    value={ignored}
                    placeholder="deploy.yml, release.yml"
                    onChange={(event) => {
                        setIgnored(event.target.value);
                        setSaved(false);
                    }}
                />
            </Stack>
            <HelperMessage>
                Comma-separated workflow file names. A workflow that reports its
                own deployment belongs here — otherwise the same run shows up
                twice on the issue, once as that deployment and once as a build
                Jira cannot relate to it.
            </HelperMessage>
            <Inline space="space.100" alignBlock="center">
                <Button onClick={saveIgnored}>Save</Button>
                {saved ? <Text>Saved.</Text> : null}
            </Inline>

            <ModalTransition>
                {open && snippet ? (
                    <Modal onClose={() => setOpen(false)} width="x-large">
                        <ModalHeader>
                            <ModalTitle>
                                Report deployments to Jira
                            </ModalTitle>
                        </ModalHeader>
                        <ModalBody>
                            <Stack space="space.200">
                                <Text>
                                    <Strong>1.</Strong> In your Forgejo
                                    repository, open{" "}
                                    <Strong>Settings → Actions → Secrets</Strong>{" "}
                                    and add a secret named{" "}
                                    <Code>JIRA_FORGEJO_SECRET</Code> with this
                                    value:
                                </Text>

                                {secret ? (
                                    <Stack space="space.050">
                                        <Code>{secret}</Code>
                                        <HelperMessage>
                                            Treat this like a password. Anyone
                                            holding it can post build and
                                            deployment results into your Jira
                                            site.
                                        </HelperMessage>
                                    </Stack>
                                ) : (
                                    <Button iconBefore="unlock" onClick={reveal}>
                                        Reveal signing secret
                                    </Button>
                                )}

                                <Text>
                                    <Strong>2.</Strong> Commit this file as{" "}
                                    <Code>.forgejo/workflows/jira.yml</Code>,
                                    then put your own deployment steps between
                                    the two reporting steps:
                                </Text>
                                <CodeBlock
                                    language="yaml"
                                    text={snippet.workflow}
                                />
                            </Stack>
                        </ModalBody>
                        <ModalFooter>
                            <Button
                                appearance="primary"
                                iconBefore="check"
                                onClick={() => setOpen(false)}
                            >
                                Done
                            </Button>
                        </ModalFooter>
                    </Modal>
                ) : null}
            </ModalTransition>
        </Stack>
    );
};
