import { Plugin } from "@opencode/plugin";
import { registerReads } from "./tools/reads.js";
import { parseConfig } from "./config.js";
import { Service } from "./core/service.js";
import { JiraCloud } from "./jira/cloud.js";
import { HttpClient } from "./http.js";
import { ChangeRuntime } from "./state/runtime.js";
import { registerChanges } from "./tools/changes.js";

export default Plugin.define({
  id: "issuekeeper.jira",
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const http = new HttpClient(config);
    const provider = new JiraCloud(config, http);
    const changes = new ChangeRuntime();
    let service: Service;
    try {
      service = await Service.create(config, ctx.location.directory, provider);
      await registerReads(ctx, service);
      await registerChanges(ctx, service, http, changes);
    } catch (error) {
      await changes.close();
      provider.close();
      throw error;
    }
    return async () => { await changes.close(); service.close(); };
  },
});
