// An issue number, or a lower-case kebab-case topic.
const scopeShape = /^(?:[1-9]\d*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "scope-shape": ({ scope }) => [
          !scope || scopeShape.test(scope),
          "scope must be an issue number or a lower-case kebab-case topic",
        ],
      },
    },
  ],
  rules: {
    "header-max-length": [2, "always", 49],
    "scope-empty": [2, "never"],
    "scope-shape": [2, "always"],
  },
};
