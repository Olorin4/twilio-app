import globals from "globals";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettier from "eslint-plugin-prettier";
import jest from "eslint-plugin-jest";

export default [
    {
        ignores: ["public/**/*.js", "public/twilio.min.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.jquery,
            },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "linebreak-style": ["error", "unix"],
            "prettier/prettier": "error",
            "no-unused-vars": ["warn", { args: "none" }],
            "no-undef": "error",
        },
    },
    {
        files: ["public/quickstart.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.jquery,
            },
        },
    },
    {
        files: [
            "*.js",
            "config.js",
            "index.js",
            "name_generator.js",
            "src/**/*.js",
            "tests/**/*.js",
        ],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.commonjs,
            },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": ["warn", { args: "none" }],
        },
    },
    pluginJs.configs.recommended,
    eslintConfigPrettier,
    {
        plugins: {
            prettier: eslintPluginPrettier,
        },
    },
    {
        files: ["tests/**/*.js"],
        languageOptions: {
            globals: globals.jest,
        },
        ...jest.configs["flat/recommended"],
    },
];
