import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: false,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      // NOTE: We deliberately do NOT set `schemas: { type: "typescript" }`
      // here. Doing so causes orval to also emit TS interface declarations
      // alongside the zod schemas — and to auto-rewrite `src/index.ts` to
      // re-export both, which produces duplicate-name errors (e.g.
      // `HealthCheckResponse` exists as both a `const` (zod schema) and an
      // `interface`). Consumers needing TS types should either:
      //   (a) `z.infer<typeof Schema>` on the zod schema (preferred), or
      //   (b) import from `@workspace/api-client-react` (TS-only generated
      //        client).
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      mode: "split",
      clean: false,
      prettier: true,
      // Prevent orval from auto-(re)writing `lib/api-zod/src/index.ts` on
      // every codegen run. We curate that file by hand so the package
      // re-exports only the zod schemas (the TS-types path lives in
      // `@workspace/api-client-react`).
      indexFiles: false,
      override: {
        zod: {
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
