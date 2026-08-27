import React from "react";
import { SectionMessage, Text } from "@forge/react";

/**
 * Placeholder for tabs whose work cannot start until an instance is connected
 * and authorized.
 *
 * The tabs stay clickable rather than being hidden or disabled, so the admin can
 * see what the app will do before committing credentials to it - a tab that only
 * appears once you have already finished tells you nothing while you are
 * deciding.
 */
export const NeedsConnection = () => (
    <SectionMessage appearance="information">
        <Text>
            Connect and authorize a Forgejo instance on the{" "}
            <Text as="strong">Connect to Forgejo</Text> tab first.
        </Text>
    </SectionMessage>
);
