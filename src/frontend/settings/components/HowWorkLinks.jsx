import React from "react";
import { Code, List, ListItem, SectionMessage, Strong, Text } from "@forge/react";

/**
 * What a developer has to do for their work to appear on this project's issues.
 *
 * This is the whole point of the page. Nothing here is configurable, so the
 * useful thing a project admin can be given is the convention their team has to
 * follow - written with this project's own key rather than a generic example, so
 * it can be copied rather than translated.
 */
export const HowWorkLinks = ({ projectKey, exampleBranch }) => (
    <SectionMessage
        title="How your work reaches this project"
        appearance="information"
    >
        <Text>
            Anything naming an issue key from this project is linked
            automatically. Nothing has to be configured per project.
        </Text>
        <List>
            <ListItem>
                <Text>
                    <Strong>Branches</Strong> — name the branch after the issue,
                    for example <Code>{exampleBranch}</Code>.
                </Text>
            </ListItem>
            <ListItem>
                <Text>
                    <Strong>Commits</Strong> — put the key in the commit message,
                    for example{" "}
                    <Code>{`${projectKey}-123 fix the redirect loop`}</Code>.
                </Text>
            </ListItem>
            <ListItem>
                <Text>
                    <Strong>Pull requests</Strong> — the key can be in the title
                    or the source branch name.
                </Text>
            </ListItem>
        </List>
        <Text>
            Work with no issue key is ignored, and commits never move an issue
            through your workflow on their own.
        </Text>
    </SectionMessage>
);
