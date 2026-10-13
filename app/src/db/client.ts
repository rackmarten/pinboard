import { createDb } from "@rackmarten/server-kit";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const { db, sql } = createDb(config.databaseUrl, schema);
