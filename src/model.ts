import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

export async function createModelRuntime(cwd: string, requested?: string) {
  const models = await ModelRuntime.create();
  const settings = SettingsManager.create(cwd);
  const preferred = requested ?? (
    settings.getDefaultProvider() && settings.getDefaultModel()
      ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}`
      : undefined
  );
  const available = models.getAvailableSnapshot();
  const model = available.find((m) => `${m.provider}/${m.id}` === preferred)
    ?? (requested ? undefined : available[0]);
  if (!model) {
    throw new Error(`No available model${preferred ? `: ${preferred}` : ""}. Log in with pi, then select provider/model-id.`);
  }
  return { models, model, available };
}
