/**
 * S3-compatible result store for CI caching.
 *
 * Targets Cloudflare R2 but should work with any S3-compatible storage.
 * Uses AWS SDK v3 for minimal dependencies and better tree-shaking.
 *
 * Cache entries are stored as JSON objects:
 *   <prefix>/<key-prefix>/<full-key>.json
 *
 * TTL is implemented via object metadata; lifecycle rules should be
 * configured on the bucket for automatic cleanup, but we also check
 * expiration on read.
 */

import type { CacheEntry, ResultStore } from "../store.ts";
import { isExpired } from "../store.ts";

export interface S3StoreConfig {
  /** S3 endpoint URL (required for R2: https://<account>.r2.cloudflarestorage.com) */
  endpoint?: string;
  /** Bucket name */
  bucket: string;
  /** Key prefix within bucket (default: "nopo-cache") */
  prefix?: string;
  /** AWS region (default: auto) */
  region?: string;
  /** Access key ID */
  accessKeyId?: string;
  /** Secret access key */
  secretAccessKey?: string;
  /** TTL in seconds for cache entries */
  ttlSeconds: number;
}

// We use fetch-based S3 API instead of full AWS SDK to keep dependencies minimal
// and avoid issues with bundling. This implements a minimal S3-compatible client.

// Request timeout in milliseconds (3 seconds)
const REQUEST_TIMEOUT_MS = 3000;

export class S3Store implements ResultStore {
  readonly name = "s3";
  private readonly config: S3StoreConfig;
  private readonly prefix: string;

  constructor(config: S3StoreConfig) {
    this.config = config;
    this.prefix = config.prefix ?? "nopo-cache";
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.bucket) return false;
    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      // Check environment
      const accessKey = process.env.AWS_ACCESS_KEY_ID;
      const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
      if (!accessKey || !secretKey) return false;
    }

    try {
      // HEAD a probe object rather than the bucket: bucket-scoped object tokens (R2
      // "Bucket Item Read/Write") may not be allowed HeadBucket, but can HeadObject.
      // 404 = authorized and absent; 401/403 = credentials cannot read the bucket.
      const response = await this.s3Request(
        "HEAD",
        `${this.prefix}/__nopo_probe__.json`,
        {},
        REQUEST_TIMEOUT_MS,
      );
      if (response.ok || response.status === 404) return true;
      console.warn(`[cache] S3 store probe returned HTTP ${response.status}; caching disabled`);
      return false;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<CacheEntry | null> {
    const objectKey = this.keyToObjectKey(key);

    // Wrap the entire operation in a timeout
    // This covers both the fetch and the body reading
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
    });

    const getPromise = (async (): Promise<CacheEntry | null> => {
      try {
        const response = await this.s3Request("GET", objectKey, {}, REQUEST_TIMEOUT_MS);

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`S3 GET failed: ${response.status} ${response.statusText}`);
        }

        const content = await response.text();
        const entry: CacheEntry = JSON.parse(content);

        // Check expiration
        if (isExpired(entry)) {
          // Clean up expired entry asynchronously (no await, fire-and-forget)
          this.delete(key).catch(() => {});
          return null;
        }

        return entry;
      } catch (err) {
        if (err instanceof Error && err.message.includes("404")) {
          return null;
        }
        // Timeout or other errors - treat as miss
        if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
          console.warn(`[cache] S3 GET timed out for ${key}`);
          return null;
        }
        console.error(`[cache] S3 GET failed for ${key}:`, err);
        return null;
      }
    })();

    // Race the get operation against the timeout
    return Promise.race([getPromise, timeoutPromise]);
  }

  async put(entry: CacheEntry): Promise<void> {
    const objectKey = this.keyToObjectKey(entry.key);
    const content = JSON.stringify(entry, null, 2);

    // PUT requests have a longer timeout since we need to wait for upload
    const response = await this.s3Request("PUT", objectKey, {
      body: content,
      headers: {
        "Content-Type": "application/json",
        // Store expiration in metadata for potential lifecycle rule usage
        "x-amz-meta-expires-at": entry.expiresAt,
      },
    }, REQUEST_TIMEOUT_MS * 3); // 9 second timeout for PUTs

    if (!response.ok) {
      throw new Error(`S3 PUT failed: ${response.status} ${response.statusText}`);
    }
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.keyToObjectKey(key);

    try {
      await this.s3Request("DELETE", objectKey, {}, REQUEST_TIMEOUT_MS);
    } catch {
      // Ignore delete errors
    }
  }

  private keyToObjectKey(key: string): string {
    // Use first 2 chars as prefix for partitioning
    const keyPrefix = key.slice(0, 2);
    return `${this.prefix}/${keyPrefix}/${key}.json`;
  }

  /**
   * Minimal S3-compatible request using AWS Signature Version 4.
   * This avoids pulling in the full AWS SDK.
   * @param timeoutMs - Request timeout in milliseconds (uses AbortSignal.timeout)
   */
  private async s3Request(
    method: string,
    objectKey: string,
    options: { body?: string; headers?: Record<string, string> },
    timeoutMs?: number,
  ): Promise<Response> {
    const accessKeyId = this.config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? "";
    const secretAccessKey = this.config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
    const region = this.config.region ?? process.env.AWS_REGION ?? "auto";
    const bucket = this.config.bucket;

    // Build URL
    let baseUrl: string;
    if (this.config.endpoint) {
      // R2 or custom endpoint: endpoint includes bucket or path style
      baseUrl = this.config.endpoint.replace(/\/$/, "");
      if (!baseUrl.includes(bucket)) {
        baseUrl = `${baseUrl}/${bucket}`;
      }
    } else {
      // Standard AWS S3
      baseUrl = `https://${bucket}.s3.${region}.amazonaws.com`;
    }

    const url = objectKey ? `${baseUrl}/${objectKey}` : baseUrl;
    const parsedUrl = new URL(url);

    // AWS Signature Version 4
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const headers: Record<string, string> = {
      Host: parsedUrl.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": await this.sha256Hex(options.body ?? ""),
      ...options.headers,
    };

    // Create canonical request
    const signedHeaders = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort()
      .join(";");

    const canonicalHeaders = Object.entries(headers)
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
      .sort()
      .join("\n");

    const canonicalRequest = [
      method,
      parsedUrl.pathname || "/",
      parsedUrl.search.slice(1), // query string without ?
      canonicalHeaders + "\n",
      signedHeaders,
      headers["x-amz-content-sha256"],
    ].join("\n");

    // Create string to sign
    const service = "s3";
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await this.sha256Hex(canonicalRequest),
    ].join("\n");

    // Calculate signature
    const signingKey = await this.getSignatureKey(
      secretAccessKey,
      dateStamp,
      region,
      service,
    );
    const signature = await this.hmacHex(signingKey, stringToSign);

    // Add authorization header
    headers.Authorization = [
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`,
    ].join(", ");

    // Create fetch options with optional timeout signal
    const fetchOptions: RequestInit = {
      method,
      headers,
      body: options.body,
    };

    if (timeoutMs !== undefined) {
      fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    }

    return fetch(url, fetchOptions);
  }

  private async sha256Hex(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const buffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
  }

  private async hmacHex(key: ArrayBuffer, data: string): Promise<string> {
    const buffer = await this.hmac(key, data);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async getSignatureKey(
    secretKey: string,
    dateStamp: string,
    region: string,
    service: string,
  ): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const kSecret = encoder.encode(`AWS4${secretKey}`);
    // Convert Uint8Array to ArrayBuffer
    const kSecretBuffer = kSecret.buffer.slice(kSecret.byteOffset, kSecret.byteOffset + kSecret.byteLength);
    const kDate = await this.hmac(kSecretBuffer, dateStamp);
    const kRegion = await this.hmac(kDate, region);
    const kService = await this.hmac(kRegion, service);
    return this.hmac(kService, "aws4_request");
  }
}
