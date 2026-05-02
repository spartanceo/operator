import { defineConfig } from "drizzle-kit";
import path from "path";

const dbFile =
  process.env.SQLITE_PATH ?? path.join(__dirname, "..", "..", "data", "omninity.db");

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: dbFile,
  },
});
