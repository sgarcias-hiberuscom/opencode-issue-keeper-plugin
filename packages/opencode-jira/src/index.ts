import { Plugin } from "@opencode/plugin";
import { registerReads } from "./tools/reads.js";
import { parseConfig } from "./config.js";
import { Service } from "./core/service.js";
import { JiraCloud } from "./jira/cloud.js";
import { HttpClient } from "./http.js";

export default Plugin.define({
  id: "issuekeeper.jira",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const provider = new JiraCloud(config, new HttpClient(config));
    let service: Service;
    try {
      service = await Service.create(config, ctx.location.directory, provider);
      await registerReads(ctx, service);
    } catch (error) {
      provider.close();
      throw error;
    }
    return () => service.close();
  },
});
