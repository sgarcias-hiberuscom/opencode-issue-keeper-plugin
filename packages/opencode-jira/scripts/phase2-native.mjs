import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [installedArg, configuration, manifestPath, rootArg, authorization] = process.argv.slice(2);
assert(authorization === "--qa-authorized", "Usage: phase2-native.mjs PACKAGE CONFIG MANIFEST NEW_ROOT --qa-authorized");
const installed = resolve(installedArg); const root = resolve(rootArg);
const require = createRequire(join(installed, "package.json"));
const config = require("jsonc-parser").parse(await readFile(configuration, "utf8"));
const entries = config.plugins.filter((item) => item?.package?.includes("opencode-jira")); assert.equal(entries.length, 1);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert(manifest.version === 1 && /^[a-z][a-z0-9_-]*$/.test(manifest.account) && /^[A-Z][A-Z0-9_]*-\d+$/.test(manifest.issueKey));
assert(["ticket", "internal", "public"].includes(manifest.audience) && typeof manifest.text === "string" && manifest.text.startsWith("IK-M5-QA "));
const selected = entries[0].options.accounts.find((account) => account.id === manifest.account);
assert(selected && new URL(selected.siteUrl).origin === manifest.site);
process.umask(0o077);
await mkdir(root, { mode: 0o700 });
for (const directory of ["project", "probe", "results", "config/opencode", "data", "cache", "home"]) await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
const options = structuredClone(entries[0].options);
options.accounts = [{ ...selected, readOnly: false }]; delete options.defaultAccount;
const source = pathToFileURL(join(installed, "dist/index.js")).href;
const probe = `import {Plugin} from '@opencode/plugin';
import jira from ${JSON.stringify(source)};
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const root=${JSON.stringify(root)}, fixture=${JSON.stringify(manifest)};
export default Plugin.define({id:'issuekeeper.qa.native',async setup(ctx){
  const cleanup=await jira.setup(ctx);
  const record=async(sessionID,phase,value)=>{if(!/^ses_[A-Za-z0-9]+$/.test(sessionID))throw Error('Invalid session');await writeFile(join(root,'results',sessionID+'-'+phase+'.json'),JSON.stringify(value,null,2),{mode:0o600,flag:'wx'})};
  const invoke=async(name,input,sessionID)=>{const tools=await ctx.tool.list();const tool=tools.find(t=>t.id==='jira_'+name||t.name==='jira_'+name);if(!tool)throw Error('Missing Jira tool');const result=JSON.parse((await tool.execute(input,{sessionID,agent:'build',messageID:'qa-native-message',id:'qa-native-call',signal:AbortSignal.timeout(600000),progress:async()=>{}})).content);return result};
  await ctx.command.transform(editor=>{
    editor.add({name:'ik-m5-prepare',description:'Preparar una propuesta QA real, sin enviarla',execute:async({sessionID})=>{
      try{await readFile(join(root,'results',sessionID+'-prepared.json'));throw Error('Session already prepared')}catch(e){if(e.code!=='ENOENT')throw e}
      const metadata=await invoke('issue_edit_metadata',{account:fixture.account,issueKey:fixture.issueKey},sessionID);if(!metadata.ok)throw Error('QA metadata unavailable');
      const result=await invoke('comment_prepare',{account:fixture.account,issueKey:fixture.issueKey,expectedUpdated:metadata.data.updated,text:fixture.text,audience:fixture.audience},sessionID);
      await record(sessionID,'prepared',result);
    }});
    editor.add({name:'ik-m5-apply',description:'Aplicar la propuesta de esta sesión tras revisión CLI y permiso nativo',execute:async({sessionID})=>{
      const prepared=JSON.parse(await readFile(join(root,'results',sessionID+'-prepared.json'),'utf8'));if(!prepared.ok)throw Error('No prepared proposal');
      try{await record(sessionID,'applied',await invoke('change_apply',{proposalId:prepared.data.proposalId},sessionID))}catch(error){await record(sessionID,'error',{name:error.name,permissionDriver:'native'});throw error}
    }});
  });
  return cleanup;
}});`;
await writeFile(join(root, "probe/index.mjs"), probe, { mode: 0o600 });
await writeFile(join(root, "probe/package.json"), JSON.stringify({ name: "issuekeeper-qa-native", type: "module", exports: { ".": "./index.mjs" }, dependencies: { "@opencode/plugin": "2.2.5" } }), { mode: 0o600 });
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({ update: "disable", plugins: [{ package: join(root, "probe"), options }], permissions: [{ action: "jira.read", resource: "*", effect: "allow" }, { action: "jira.write", resource: "*", effect: "ask" }, ...["shell", "read", "edit", "external_directory"].map((action) => ({ action, resource: "*", effect: "deny" }))] }, null, 2), { mode: 0o600 });
await writeFile(join(root, "password"), randomUUID(), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ root, project: join(root, "project"), commands: ["ik-m5-prepare", "ik-m5-apply"], humanDecision: "requires real operator interaction" }));
