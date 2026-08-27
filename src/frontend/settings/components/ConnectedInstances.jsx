import React from "react";
import { Box, Heading, Inline, Link, Lozenge, Stack, Strong } from "@forge/react";

/**
 * Which Forgejo instances this site trusts, read-only.
 *
 * A project admin cannot change any of it - connecting an instance is a
 * site-wide decision - but they can see whether the one feeding their issues is
 * still authorized, which is the usual reason development data stops appearing.
 */
export const ConnectedInstances = ({ connections }) => (
    <Stack space="space.100">
        <Heading as="h3">Connected instances</Heading>
        {connections.map((connection) => (
            <Box
                key={connection.id}
                padding="space.200"
                backgroundColor="color.background.neutral.subtle"
            >
                <Inline space="space.100" alignBlock="center">
                    <Strong>{connection.name}</Strong>
                    {connection.connected ? (
                        <Lozenge appearance="success">Authorized</Lozenge>
                    ) : (
                        <Lozenge appearance="removed">Not authorized</Lozenge>
                    )}
                    <Link href={connection.instanceUrl} openNewTab>
                        {connection.instanceUrl}
                    </Link>
                </Inline>
            </Box>
        ))}
    </Stack>
);
