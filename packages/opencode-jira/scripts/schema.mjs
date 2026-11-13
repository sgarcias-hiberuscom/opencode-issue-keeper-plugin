import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigSchema } from "../dist/config.js";

const schema = z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any" });
await writeFile(new URL("../options.schema.json", import.meta.url), JSON.stringify(schema, null, 2) + "\n");
