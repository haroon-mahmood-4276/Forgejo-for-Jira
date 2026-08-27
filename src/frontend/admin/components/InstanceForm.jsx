import React, { useState } from "react";
import {
    Code,
    ErrorMessage,
    Form,
    FormFooter,
    FormSection,
    Heading,
    HelperMessage,
    Label,
    List,
    ListItem,
    LoadingButton,
    SectionMessage,
    Stack,
    Strong,
    Text,
    Textfield,
    useForm,
} from "@forge/react";
import { invoke } from "@forge/bridge";

/**
 * Register a Forgejo instance.
 *
 * The instructions come before the form because the values the form asks for do
 * not exist until the admin has created an OAuth application in Forgejo - a form
 * shown first would be four boxes nobody can fill in.
 */
export const InstanceForm = ({ redirectUri, reload, onError }) => {
    const [busy, setBusy] = useState(false);
    const { handleSubmit, register, getFieldId, formState } = useForm();

    const onSubmit = async (data) => {
        setBusy(true);
        onError(null);
        try {
            await invoke("createConnection", data);
            await reload();
        } catch (submitError) {
            onError(submitError.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Stack space="space.100">
            <Heading as="h3">Register an OAuth application in Forgejo</Heading>

            <SectionMessage appearance="information">
                <List type="ordered">
                    <ListItem>
                        <Text>
                            In Forgejo, open{" "}
                            <Strong>Site Administration → Applications</Strong>{" "}
                            (to cover every repository on the instance) or your
                            own <Strong>Settings → Applications</Strong> (to
                            cover only yours).
                        </Text>
                    </ListItem>
                    <ListItem>
                        <Text>
                            Create an OAuth2 application. Name it anything;{" "}
                            <Strong>Confidential Client</Strong> must stay
                            enabled.
                        </Text>
                    </ListItem>
                    <ListItem>
                        <Text>
                            Paste this exact value into the Redirect URI field:
                        </Text>
                        <Code>{redirectUri}</Code>
                    </ListItem>
                    <ListItem>
                        <Text>
                            Copy the Client ID and Client Secret it generates
                            into the form below.
                        </Text>
                    </ListItem>
                </List>
            </SectionMessage>

            <SectionMessage appearance="warning">
                <Text>
                    Forgejo has not implemented OAuth scopes, so the token issued
                    in the next step carries the full permissions of whoever
                    approves it. Approve with an account that has access to only
                    the repositories you intend to link.
                </Text>
            </SectionMessage>

            <Form onSubmit={handleSubmit(onSubmit)}>
                <FormSection>
                    <Stack space="space.100">
                        <Stack space="space.050">
                            <Label labelFor={getFieldId("instanceUrl")}>
                                Forgejo instance URL
                            </Label>
                            <Textfield
                                {...register("instanceUrl", { required: true })}
                                placeholder="https://forgejo.example.com"
                            />
                        </Stack>
                        <HelperMessage>
                            Base URL only, no trailing path. Must use HTTPS.
                        </HelperMessage>
                        {formState.errors.instanceUrl ? (
                            <ErrorMessage>Instance URL is required.</ErrorMessage>
                        ) : null}

                        <Stack space="space.050">
                            <Label labelFor={getFieldId("name")}>Display name</Label>
                            <Textfield
                                {...register("name")}
                                placeholder="Company Forgejo"
                            />
                        </Stack>
                        <HelperMessage>
                            Optional. Defaults to the hostname.
                        </HelperMessage>

                        <Stack space="space.050">
                            <Label labelFor={getFieldId("clientId")}>
                                OAuth client ID
                            </Label>
                            <Textfield
                                {...register("clientId", { required: true })}
                            />
                        </Stack>
                        {formState.errors.clientId ? (
                            <ErrorMessage>Client ID is required.</ErrorMessage>
                        ) : null}

                        <Stack space="space.050">
                            <Label labelFor={getFieldId("clientSecret")}>
                                OAuth client secret
                            </Label>
                            <Textfield
                                {...register("clientSecret", { required: true })}
                                type="password"
                            />
                        </Stack>
                        <HelperMessage>
                            Stored encrypted and never displayed again.
                        </HelperMessage>
                        {formState.errors.clientSecret ? (
                            <ErrorMessage>Client secret is required.</ErrorMessage>
                        ) : null}
                    </Stack>
                </FormSection>
                <FormFooter>
                    <LoadingButton
                        type="submit"
                        appearance="primary"
                        iconBefore="add"
                        isLoading={busy}
                    >
                        Save and continue
                    </LoadingButton>
                </FormFooter>
            </Form>
        </Stack>
    );
};
