import { defineDoc, defineExtension, defineTool, type JsonObject } from "@earendil-works/pi-durable";
import type { AuditSelection } from "./audit-reader.ts";
import { pinnedFileTool, readPinnedAuditFile, readSavedAuditPage, savedAuditTool } from "./audit-tools.ts";

const SelectedAudit = defineDoc<{ selection: AuditSelection | null }>({
  kind: "app.audit-discussion", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ selection: null }),
});

const readSavedAudit = defineTool({
  ...savedAuditTool,
  replay: "safe",
  execute: async (args, api, context) => {
    const cached = await api.memo<{ selection: AuditSelection; page: JsonObject }>("audit-read", context);
    const result = cached ?? await api.memo("audit-read", readSavedAuditPage(args,
      (await api.snapshot(SelectedAudit, api.conversationId, context))?.selection), context);
    await api.commit(async (tx) => { (await tx.doc(SelectedAudit, api.conversationId)).selection = result.selection; }, context);
    return { output: [{ type: "text", text: JSON.stringify(result.page) }] };
  },
});

const readPinnedFile = defineTool({
  ...pinnedFileTool,
  replay: "safe",
  execute: async (args, api, context) => {
    const cached = await api.memo<JsonObject>("pinned-file", context);
    const result = cached ?? await api.memo("pinned-file", await readPinnedAuditFile(args,
      (await api.snapshot(SelectedAudit, api.conversationId, context))?.selection, undefined, context.abortSignal), context);
    return { output: [{ type: "text", text: JSON.stringify(result) }] };
  },
});

export const AuditDiscussion = defineExtension({ name: "audit-discussion", tools: [readSavedAudit, readPinnedFile] });
