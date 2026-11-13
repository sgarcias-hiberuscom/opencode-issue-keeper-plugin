import { Plugin } from "@opencode/plugin";
import { registerReads } from "./tools/reads.js";
import { parseConfig } from "./config.js";
import { Service } from "./core/service.js";

export default Plugin.define({
  id: "issuekeeper.jira",
  async setup(ctx) {
    const service = await Service.create(parseConfig(ctx.options), ctx.location.directory);
    try {
      await registerReads(ctx, service);
    } catch (error) {
      service.close();
      throw error;
    }
    return () => service.close();
  },
});
