import { fragmentRegistry } from "../core/FragmentRegistry";

interface ReferencedArticleArgs {
    title: string;
    content: string;
    dTag: string;
}

fragmentRegistry.register<ReferencedArticleArgs>({
    id: "referenced-article",
    priority: 10, // High priority to appear early in the prompt
    template: ({ title, content, dTag }) => {
        return `This conversation is about this spec file:
<spec dTag="${dTag}">
# ${title}

${content}
</spec>
`;
    },
});
