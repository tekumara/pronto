import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { isAbsolute } from "node:path";
import { stateDirectory, repositoryDatabasePath } from "./state.ts";

export type ReplicaConfig = {
  bucket: string; prefix: string; region: string; endpoint?: string; pathStyle: boolean;
  stateBase: string; binary: string;
};

/** Called only by flagged serve. One base and one transport configuration for control and Litestream. */
export function replicaConfig(env: NodeJS.ProcessEnv = process.env): ReplicaConfig {
  const invalid = () => new Error("PRONTO_REPLICA_URL must be s3://bucket/non-empty-prefix, without credentials, query, escapes or relative segments");
  const raw = env.PRONTO_REPLICA_URL;
  if (!raw || !/^s3:\/\/[a-z0-9][a-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(raw)) throw invalid();
  const [bucket, ...parts] = raw.slice(5).split("/");
  const prefix = parts.join("/").replace(/\/$/, "");
  if (!prefix || prefix.split("/").some((p) => !p || p === "." || p === "..")) throw invalid();
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region || !/^[a-z0-9-]+$/.test(region)) throw new Error("AWS_REGION is required for replicated state");
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Replicated state requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN for temporary credentials)");
  }
  // The JS SDK prefers AWS_PROFILE over environment keys, unlike the required shared environment setup.
  if (env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE) {
    throw new Error("Unset AWS_PROFILE and AWS_DEFAULT_PROFILE for replicated state; the SDK and Litestream must use the same environment credentials");
  }
  let endpoint: string | undefined;
  if (env.PRONTO_S3_ENDPOINT) {
    const url = new URL(env.PRONTO_S3_ENDPOINT);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("PRONTO_S3_ENDPOINT must be an http(s) origin without credentials, path or query");
    }
    endpoint = url.origin;
  }
  if (env.PRONTO_S3_PATH_STYLE && !["true", "false"].includes(env.PRONTO_S3_PATH_STYLE)) throw new Error("PRONTO_S3_PATH_STYLE must be true or false");
  const binary = env.PRONTO_LITESTREAM_BIN;
  if (!binary || !isAbsolute(binary)) throw new Error("PRONTO_LITESTREAM_BIN must be the absolute path to stock Litestream v0.5.17");
  // stateDirectory validates the override, without changing the process environment for a term.
  return { bucket: bucket!, prefix, region, endpoint, pathStyle: env.PRONTO_S3_PATH_STYLE ? env.PRONTO_S3_PATH_STYLE === "true" : !!endpoint,
    stateBase: stateDirectory(env), binary };
}

export function replicaURL(config: ReplicaConfig, prefix: string): string {
  const params = new URLSearchParams({ region: config.region, "force-path-style": String(config.pathStyle) });
  if (config.endpoint) params.set("endpoint", config.endpoint);
  return `s3://${config.bucket}/${prefix}?${params}`;
}

export type ControlRecord = {
  revision: string; owner: string | null; expires: number;
  phase: "idle" | "bootstrapping" | "ready"; recovery: string | null;
};
export type ControlHead = { record: ControlRecord; etag: string };
export type RestorePoint = { relative: string; txid: string };
export const conditionalConflict = (error: unknown) => [409, 412].includes((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0);

/** No SDK write retries: a lost PUT response is uncertainty, not permission to replay against a newer ETag. */
export class S3Control {
  private readonly client: S3Client;
  private readonly config: ReplicaConfig;
  constructor(config: ReplicaConfig) {
    this.config = config;
    this.client = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.pathStyle,
      maxAttempts: 1, requestHandler: { requestTimeout: 5_000, connectionTimeout: 3_000, socketTimeout: 5_000, throwOnRequestTimeout: true } });
  }
  async read(): Promise<ControlHead | null> {
    let result;
    try { result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: `${this.config.prefix}/control.json` })); }
    catch (error) { if ((error as { name?: string }).name === "NoSuchKey") return null; throw error; }
    const record = JSON.parse(await result.Body!.transformToString()) as ControlRecord;
    if (!result.ETag || !record || typeof record.revision !== "string" || !/^[a-f0-9-]{36}$/.test(record.revision)
      || (record.owner !== null && !/^[a-f0-9-]{36}$/.test(record.owner)) || !Number.isFinite(record.expires)
      || !["idle", "bootstrapping", "ready"].includes(record.phase)
      || (record.phase === "idle") !== (record.owner === null)
      || (record.recovery !== null && !this.validPrefix(record.recovery))
      || (record.phase === "ready" && record.recovery === null)) throw new Error("Invalid replicated-state control record; refusing recovery");
    return { record, etag: result.ETag };
  }
  private validPrefix(prefix: string): boolean {
    return typeof prefix === "string" && new RegExp(`^${this.config.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/terms/[a-f0-9-]{36}$`).test(prefix);
  }
  async write(record: ControlRecord, previous: ControlHead | null): Promise<ControlHead> {
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: `${this.config.prefix}/control.json`,
      Body: JSON.stringify(record), ContentType: "application/json", ...(previous ? { IfMatch: previous.etag } : { IfNoneMatch: "*" }) }));
    if (!result.ETag) throw new Error("Control PUT response has no ETag; ownership is uncertain");
    return { record, etag: result.ETag };
  }
  /** Inventory is read only after acquisition. Every discovered database must have a fixed restorable endpoint. */
  async inventory(prefix: string): Promise<RestorePoint[]> {
    if (!this.validPrefix(prefix)) throw new Error("Invalid recovery prefix");
    const databases = new Map<string, string>();
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
      for (const item of page.Contents ?? []) {
        const key = item.Key!.slice(prefix.length + 1);
        const match = /^(repos\/[^/]+\/[^/]+\.sqlite)\/([0-9a-f]{4})\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx$/.exec(key);
        if (!match) throw new Error("Unexpected object in recovery inventory; refusing incomplete recovery");
        const [, relative, , min, max] = match;
        repositoryDatabasePath("/validation", relative!);
        if (min! > max! || max === "0000000000000000") throw new Error("Invalid LTX endpoint in recovery inventory");
        if (!databases.has(relative!) || max! > databases.get(relative!)!) databases.set(relative!, max!);
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error("Truncated inventory without continuation token");
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return [...databases].sort().map(([relative, txid]) => ({ relative, txid }));
  }
  close(): void { this.client.destroy(); }
}
