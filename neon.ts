import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    functions: {
      zuara: {
        name: "ZUARA API",
        source: "./functions/zuara-api.ts",
      },
    },
  },
});
