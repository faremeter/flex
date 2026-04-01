import { OptionDefaults } from "typedoc";

export default {
  plugin: ["typedoc-plugin-markdown", "typedoc-plugin-frontmatter"],
  name: "Flex API",
  entryPointStrategy: "resolve",
  entryPoints: ["packages/*/src/index.ts"],
  out: "docs/api",
  readme: "none",
  entryFileName: "index",
  router: "module",
  cleanOutputDir: true,
  excludeScopesInPaths: true,
  sourceLinkTemplate:
    "https://github.com/faremeter/flex/blob/main/{path}#L{line}",
  exclude: [
    "**/node_modules/**",
    "scripts/**",
    "apps/**",
    "tests/**",
    "**/*.test.ts",
  ],
  tsconfig: "tsconfig.typedoc.json",
  sanitizeComments: true,
  flattenOutputFiles: true,
  blockTags: [
    ...OptionDefaults.blockTags,
    "@title",
    "@sidebarTitle",
    "@description",
  ],
  frontmatterCommentTags: ["title", "sidebarTitle", "description"],
  indexFrontmatter: {
    title: "Flex API Reference",
    sidebarTitle: "API Reference",
    description: "API reference documentation for the Flex Payment Scheme SDK",
  },
};
