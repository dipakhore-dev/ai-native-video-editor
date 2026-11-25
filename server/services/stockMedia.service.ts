import dns from "node:dns/promises";
import net from "node:net";
import { z } from "zod";
import { getEnvConfig, isStockMediaConfigured } from "../config/env.ts";
import { sanitizeErrorMessage } from "../middleware/security.middleware.ts";
import { detectBufferMediaMagic } from "../utils/fileMagic.ts";

export type StockMediaTypeFilter = "image" | "video";
export type StockOrientation = "landscape" | "portrait" | "square";

export interface StockSearchParams {
  query: string;
  mediaType: StockMediaTypeFilter;
  orientation?: StockOrientation;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  page?: number;
  perPage?: number;
}

export interface StockSearchItem {
  providerName: "pexels";
  providerAssetId: string;
  mediaType: StockMediaTypeFilter;
  title: string;
  previewImageUrl: string;
  width: number;
  height: number;
  duration?: number;
  creatorName: string;
  attributionUrl: string;
  licenseInfo: string;
  suggestedFilename: string;
}

export interface StockMediaStatusInfo {
  enabled: boolean;
  configured: boolean;
  provider: "none" | "pexels";
  maxResults: number;
  maxImportMb: number;
  message: string;
}

export interface StockImportedBinary {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  mediaType: StockMediaTypeFilter;
  providerName: "pexels";
  providerAssetId: string;
  title: string;
  width?: number;
  height?: number;
  duration?: number;
  creatorName: string;
  attributionUrl: string;
  licenseInfo: string;
  sourceUrl: string;
}

export interface StockMediaProviderDeps {
  fetchImpl?: typeof fetch;
  dnsLookup?: (
    hostname: string
  ) => Promise<Array<{ address: string; family: number }>>;
  env?: NodeJS.ProcessEnv;
}

export interface StockMediaProvider {
  readonly name: "pexels";
  search(
    params: StockSearchParams,
    abortSignal?: AbortSignal
  ): Promise<StockSearchItem[]>;
  resolveImportMetadata(
    params: { providerAssetId: string; mediaType: StockMediaTypeFilter },
    abortSignal?: AbortSignal
  ): Promise<{
    downloadUrl: string;
    mimeType: string;
    filename: string;
    title: string;
    width?: number;
    height?: number;
    duration?: number;
    creatorName: string;
    attributionUrl: string;
    licenseInfo: string;
  }>;
}

export const StockSearchRequestSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Enter a search keyword for stock media.")
    .max(120, "Search query must be 120 characters or fewer."),
  mediaType: z.enum(["image", "video"]).default("video"),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  orientation: z.enum(["landscape", "portrait", "square"]).optional(),
  page: z.number().int().min(1).max(20).optional().default(1),
  perPage: z.number().int().min(1).max(30).optional(),
});

export const StockImportRequestSchema = z.object({
  provider: z.literal("pexels"),
  providerAssetId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid stock asset ID format."),
  mediaType: z.enum(["image", "video"]),
});

const ALLOWED_STOCK_EXACT_HOSTS = new Set([
  "api.pexels.com",
  "images.pexels.com",
  "videos.pexels.com",
  "www.pexels.com",
  "pexels.com",
  "vod-progressive.akamaized.net",
]);

const MAX_CONCURRENT_STOCK_IMPORTS = 2;
const MAX_REDIRECT_HOPS = 3;
let activeStockImportCount = 0;

function mapAspectRatioToOrientation(
  aspectRatio?: "16:9" | "9:16" | "1:1",
  explicit?: StockOrientation
): StockOrientation | undefined {
  if (explicit) return explicit;
  if (aspectRatio === "16:9") return "landscape";
  if (aspectRatio === "9:16") return "portrait";
  if (aspectRatio === "1:1") return "square";
  return undefined;
}

export function isPrivateOrLoopbackIp(rawIp: string): boolean {
  const cleaned = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = net.isIP(cleaned);
  if (ipVersion === 0) {
    return true;
  }

  if (ipVersion === 4) {
    const parts = cleaned.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6
  if (cleaned === "::" || cleaned === "::1") return true;
  if (cleaned.startsWith("::ffff:")) {
    const embeddedV4 = cleaned.slice("::ffff:".length);
    if (net.isIP(embeddedV4) === 4) {
      return isPrivateOrLoopbackIp(embeddedV4);
    }
    return true;
  }
  const firstSegment = cleaned.split(":")[0] || "";
  const firstVal = Number.parseInt(firstSegment || "0", 16);
  if (!Number.isFinite(firstVal)) return true;
  // fc00::/7 (Unique Local Addresses)
  if ((firstVal & 0xfe00) === 0xfc00) return true;
  // fe80::/10 (Link-local)
  if ((firstVal & 0xffc0) === 0xfe80) return true;
  // ff00::/8 (Multicast)
  if ((firstVal & 0xff00) === 0xff00) return true;

  return false;
}

export function isAllowedStockHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  if (ALLOWED_STOCK_EXACT_HOSTS.has(host)) {
    return true;
  }
  if (host.endsWith(".pexels.com") || host.endsWith(".pexels-cdn.com")) {
    return true;
  }
  return false;
}

export async function validateStockRemoteUrl(
  rawUrl: string,
  deps?: Pick<StockMediaProviderDeps, "dnsLookup">
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("Stock media URL is malformed."), { statusCode: 400 });
  }

  if (parsed.protocol !== "https:") {
    throw Object.assign(new Error("Only HTTPS stock media endpoints are allowed."), {
      statusCode: 403,
    });
  }

  if (parsed.username || parsed.password) {
    throw Object.assign(new Error("Embedded URL credentials are not permitted."), {
      statusCode: 403,
    });
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (net.isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".local")) {
    throw Object.assign(
      new Error("Direct IP or local network addresses are blocked for stock media requests."),
      { statusCode: 403 }
    );
  }

  if (!isAllowedStockHostname(hostname)) {
    throw Object.assign(
      new Error(`Host '${hostname}' is not in the allowlisted stock media domains.`),
      { statusCode: 403 }
    );
  }

  const lookupFn =
    deps?.dnsLookup ??
    ((h: string) => dns.lookup(h, { all: true }));

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(hostname);
  } catch {
    throw Object.assign(new Error("Failed to resolve stock media hostname."), {
      statusCode: 502,
    });
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw Object.assign(new Error("Stock media hostname resolved to no addresses."), {
      statusCode: 502,
    });
  }

  for (const rec of records) {
    if (isPrivateOrLoopbackIp(rec.address)) {
      throw Object.assign(
        new Error("Stock media target resolved to a blocked private or loopback IP."),
        { statusCode: 403 }
      );
    }
  }

  return parsed;
}

async function fetchWithSsrfGuard(
  initialUrl: string,
  init: RequestInit,
  deps?: StockMediaProviderDeps
): Promise<globalThis.Response> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const validatedUrl = await validateStockRemoteUrl(currentUrl, deps);
    const response = await fetchFn(validatedUrl.toString(), {
      ...init,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw Object.assign(new Error("Stock media provider returned an invalid redirect."), {
          statusCode: 502,
        });
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        throw Object.assign(new Error("Stock media provider exceeded maximum redirects."), {
          statusCode: 502,
        });
      }
      currentUrl = new URL(location, validatedUrl).toString();
      continue;
    }

    return response;
  }

  throw Object.assign(new Error("Stock media redirect loop detected."), { statusCode: 502 });
}

async function readBoundedResponseBuffer(
  response: globalThis.Response,
  maxBytes: number
): Promise<Buffer> {
  const headerLen = response.headers.get("content-length");
  if (headerLen) {
    const declaredBytes = Number(headerLen);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw Object.assign(
        new Error(
          `Stock media file exceeds the maximum allowed import size (${Math.round(
            maxBytes / (1024 * 1024)
          )} MB).`
        ),
        { statusCode: 413 }
      );
    }
  }

  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw Object.assign(
        new Error("Stock media file exceeds the maximum allowed import size."),
        { statusCode: 413 }
      );
    }
    return Buffer.from(ab);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw Object.assign(
            new Error(
              `Stock media download aborted: stream exceeded ${Math.round(
                maxBytes / (1024 * 1024)
              )} MB limit.`
            ),
            { statusCode: 413 }
          );
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

function sanitizeSafeSlug(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

interface PexelsPhotoPayload {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer?: string;
  alt?: string;
  src?: {
    original?: string;
    large2x?: string;
    large?: string;
    medium?: string;
  };
}

interface PexelsVideoFilePayload {
  id?: number;
  quality?: string;
  file_type?: string;
  width?: number;
  height?: number;
  link?: string;
}

interface PexelsVideoPayload {
  id: number;
  width: number;
  height: number;
  duration?: number;
  url: string;
  image?: string;
  user?: {
    name?: string;
  };
  video_files?: PexelsVideoFilePayload[];
}

export class PexelsStockMediaProvider implements StockMediaProvider {
  public readonly name = "pexels" as const;

  constructor(
    private readonly apiKey: string,
    private readonly deps?: StockMediaProviderDeps
  ) {}

  async search(
    params: StockSearchParams,
    abortSignal?: AbortSignal
  ): Promise<StockSearchItem[]> {
    const cfg = getEnvConfig(this.deps?.env);
    const orientation = mapAspectRatioToOrientation(params.aspectRatio, params.orientation);
    const perPage = Math.min(params.perPage ?? cfg.stockMediaMaxResults, cfg.stockMediaMaxResults);
    const page = Math.max(1, params.page ?? 1);

    const endpoint =
      params.mediaType === "video"
        ? new URL("https://api.pexels.com/videos/search")
        : new URL("https://api.pexels.com/v1/search");

    endpoint.searchParams.set("query", params.query);
    endpoint.searchParams.set("per_page", String(perPage));
    endpoint.searchParams.set("page", String(page));
    if (orientation) {
      endpoint.searchParams.set("orientation", orientation);
    }

    const res = await fetchWithSsrfGuard(
      endpoint.toString(),
      {
        method: "GET",
        headers: {
          Authorization: this.apiKey,
          Accept: "application/json",
        },
        signal: abortSignal,
      },
      this.deps
    );

    if (res.status === 401 || res.status === 403) {
      throw Object.assign(
        new Error("Pexels API key is invalid or unauthorized. Verify PEXELS_API_KEY."),
        { statusCode: 503, integrationPoint: "Pexels Stock Media API" }
      );
    }
    if (res.status === 429) {
      throw Object.assign(
        new Error("Pexels API rate limit reached. Wait briefly or upload local media instead."),
        { statusCode: 429 }
      );
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`Pexels API returned HTTP ${res.status} while searching stock media.`),
        { statusCode: 502 }
      );
    }

    const body = (await res.json()) as {
      photos?: PexelsPhotoPayload[];
      videos?: PexelsVideoPayload[];
    };

    if (params.mediaType === "image") {
      const photos = Array.isArray(body.photos) ? body.photos : [];
      return photos.map((photo) => {
        const title = (photo.alt || `Pexels Photo ${photo.id}`).trim().slice(0, 120);
        const creatorName = (photo.photographer || "Pexels Contributor").trim().slice(0, 120);
        const preview = photo.src?.medium || photo.src?.large || "";
        return {
          providerName: "pexels",
          providerAssetId: String(photo.id),
          mediaType: "image",
          title,
          previewImageUrl: preview,
          width: Math.max(1, Number(photo.width) || 1280),
          height: Math.max(1, Number(photo.height) || 720),
          creatorName,
          attributionUrl: photo.url || `https://www.pexels.com/photo/${photo.id}/`,
          licenseInfo: "Pexels Free License (attribution appreciated)",
          suggestedFilename: `${sanitizeSafeSlug(title, `pexels_photo_${photo.id}`)}.jpg`,
        };
      });
    }

    const videos = Array.isArray(body.videos) ? body.videos : [];
    return videos.map((video) => {
      const title = `Pexels Video ${video.id}`;
      const creatorName = (video.user?.name || "Pexels Contributor").trim().slice(0, 120);
      return {
        providerName: "pexels",
        providerAssetId: String(video.id),
        mediaType: "video",
        title,
        previewImageUrl: video.image || "",
        width: Math.max(1, Number(video.width) || 1280),
        height: Math.max(1, Number(video.height) || 720),
        duration: Math.max(1, Number(video.duration) || 8),
        creatorName,
        attributionUrl: video.url || `https://www.pexels.com/video/${video.id}/`,
        licenseInfo: "Pexels Free License (attribution appreciated)",
        suggestedFilename: `pexels_video_${video.id}.mp4`,
      };
    });
  }

  async resolveImportMetadata(
    params: { providerAssetId: string; mediaType: StockMediaTypeFilter },
    abortSignal?: AbortSignal
  ) {
    const endpoint =
      params.mediaType === "video"
        ? `https://api.pexels.com/videos/videos/${encodeURIComponent(params.providerAssetId)}`
        : `https://api.pexels.com/v1/photos/${encodeURIComponent(params.providerAssetId)}`;

    const res = await fetchWithSsrfGuard(
      endpoint,
      {
        method: "GET",
        headers: {
          Authorization: this.apiKey,
          Accept: "application/json",
        },
        signal: abortSignal,
      },
      this.deps
    );

    if (res.status === 404) {
      throw Object.assign(new Error("Requested Pexels asset ID was not found."), {
        statusCode: 404,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(
        new Error("Pexels API key rejected this request. Check PEXELS_API_KEY."),
        { statusCode: 503, integrationPoint: "Pexels Stock Media API" }
      );
    }
    if (res.status === 429) {
      throw Object.assign(new Error("Pexels API rate limit reached. Try again later."), {
        statusCode: 429,
      });
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`Pexels API returned HTTP ${res.status} inspecting asset metadata.`),
        { statusCode: 502 }
      );
    }

    if (params.mediaType === "image") {
      const photo = (await res.json()) as PexelsPhotoPayload;
      const downloadUrl =
        photo.src?.large2x || photo.src?.large || photo.src?.original || photo.src?.medium || "";
      if (!downloadUrl) {
        throw Object.assign(new Error("Pexels photo response has no downloadable image URL."), {
          statusCode: 502,
        });
      }
      const title = (photo.alt || `Pexels Photo ${photo.id}`).trim().slice(0, 120);
      return {
        downloadUrl,
        mimeType: "image/jpeg",
        filename: `${sanitizeSafeSlug(title, `pexels_photo_${photo.id}`)}.jpg`,
        title,
        width: photo.width,
        height: photo.height,
        creatorName: (photo.photographer || "Pexels Contributor").trim().slice(0, 120),
        attributionUrl: photo.url || `https://www.pexels.com/photo/${photo.id}/`,
        licenseInfo: "Pexels Free License (attribution appreciated)",
      };
    }

    const video = (await res.json()) as PexelsVideoPayload;
    const files = Array.isArray(video.video_files) ? video.video_files : [];
    const mp4Files = files.filter(
      (f) => f.link && (!f.file_type || f.file_type.toLowerCase().includes("mp4"))
    );
    // Prefer 720p/1080p HD renditions to keep laptop RAM/IndexedDB usage responsive
    const sorted = [...mp4Files].sort((a, b) => {
      const wa = Number(a.width) || 0;
      const wb = Number(b.width) || 0;
      const aIdeal = wa >= 960 && wa <= 1920 ? 0 : 1;
      const bIdeal = wb >= 960 && wb <= 1920 ? 0 : 1;
      if (aIdeal !== bIdeal) return aIdeal - bIdeal;
      return wb - wa;
    });
    const chosen = sorted[0] ?? files.find((f) => Boolean(f.link));
    if (!chosen?.link) {
      throw Object.assign(new Error("Pexels video response has no downloadable MP4 stream."), {
        statusCode: 502,
      });
    }

    const title = `Pexels Video ${video.id}`;
    return {
      downloadUrl: chosen.link,
      mimeType: chosen.file_type || "video/mp4",
      filename: `pexels_video_${video.id}.mp4`,
      title,
      width: chosen.width || video.width,
      height: chosen.height || video.height,
      duration: video.duration,
      creatorName: (video.user?.name || "Pexels Contributor").trim().slice(0, 120),
      attributionUrl: video.url || `https://www.pexels.com/video/${video.id}/`,
      licenseInfo: "Pexels Free License (attribution appreciated)",
    };
  }
}

export function getStockMediaStatus(
  env: NodeJS.ProcessEnv = process.env
): StockMediaStatusInfo {
  const cfg = getEnvConfig(env);
  const configured = isStockMediaConfigured(env);
  if (cfg.stockMediaProvider === "none") {
    return {
      enabled: false,
      configured: false,
      provider: "none",
      maxResults: cfg.stockMediaMaxResults,
      maxImportMb: Math.round(cfg.stockMediaMaxImportBytes / (1024 * 1024)),
      message:
        "Free stock media search is disabled (STOCK_MEDIA_PROVIDER=none). Set STOCK_MEDIA_PROVIDER=pexels and PEXELS_API_KEY on the server to enable optional free stock search, or upload local files / generate text slides.",
    };
  }
  if (!cfg.pexelsApiKey) {
    return {
      enabled: false,
      configured: false,
      provider: "pexels",
      maxResults: cfg.stockMediaMaxResults,
      maxImportMb: Math.round(cfg.stockMediaMaxImportBytes / (1024 * 1024)),
      message:
        "STOCK_MEDIA_PROVIDER=pexels is selected, but PEXELS_API_KEY is missing in the server environment.",
    };
  }
  return {
    enabled: configured,
    configured,
    provider: "pexels",
    maxResults: cfg.stockMediaMaxResults,
    maxImportMb: Math.round(cfg.stockMediaMaxImportBytes / (1024 * 1024)),
    message:
      "Pexels free stock media provider is active with server-side proxy verification and local IndexedDB import.",
  };
}

function createConfiguredProvider(deps?: StockMediaProviderDeps): StockMediaProvider {
  const env = deps?.env ?? process.env;
  const cfg = getEnvConfig(env);
  const status = getStockMediaStatus(env);
  if (!status.enabled) {
    throw Object.assign(new Error(status.message), {
      statusCode: 503,
      integrationPoint: "Pexels Stock Media API",
    });
  }
  return new PexelsStockMediaProvider(cfg.pexelsApiKey, deps);
}

export async function searchStockMedia(
  params: StockSearchParams,
  deps?: StockMediaProviderDeps & { provider?: StockMediaProvider }
): Promise<{ provider: "pexels"; items: StockSearchItem[] }> {
  const cfg = getEnvConfig(deps?.env);
  const provider = deps?.provider ?? createConfiguredProvider(deps);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.stockMediaRequestTimeoutMs);
  try {
    const items = await provider.search(params, controller.signal);
    return {
      provider: provider.name,
      items: items.slice(0, cfg.stockMediaMaxResults),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw Object.assign(
        new Error("Stock media search timed out waiting for the provider."),
        { statusCode: 504 }
      );
    }
    if ((err as { statusCode?: number })?.statusCode) {
      throw err;
    }
    throw Object.assign(
      new Error(
        sanitizeErrorMessage(
          err instanceof Error ? err.message : "Failed to search stock media."
        )
      ),
      { statusCode: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function importStockMediaAsset(
  params: { provider: "pexels"; providerAssetId: string; mediaType: StockMediaTypeFilter },
  deps?: StockMediaProviderDeps & { provider?: StockMediaProvider }
): Promise<StockImportedBinary> {
  if (activeStockImportCount >= MAX_CONCURRENT_STOCK_IMPORTS) {
    throw Object.assign(
      new Error("Too many stock media downloads are currently running. Please wait a moment."),
      { statusCode: 429 }
    );
  }

  const cfg = getEnvConfig(deps?.env);
  const provider = deps?.provider ?? createConfiguredProvider(deps);

  activeStockImportCount += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.stockMediaRequestTimeoutMs * 2);

  try {
    const meta = await provider.resolveImportMetadata(
      { providerAssetId: params.providerAssetId, mediaType: params.mediaType },
      controller.signal
    );

    const downloadRes = await fetchWithSsrfGuard(
      meta.downloadUrl,
      {
        method: "GET",
        signal: controller.signal,
      },
      deps
    );

    if (!downloadRes.ok) {
      throw Object.assign(
        new Error(`Stock CDN returned HTTP ${downloadRes.status} downloading asset.`),
        { statusCode: 502 }
      );
    }

    const buffer = await readBoundedResponseBuffer(downloadRes, cfg.stockMediaMaxImportBytes);
    const magic = detectBufferMediaMagic(buffer, meta.filename);
    if (!magic.valid || magic.detectedKind !== params.mediaType) {
      throw Object.assign(
        new Error(
          magic.reason ||
            `Downloaded stock file signature (${magic.detectedKind || "unknown"}) did not match expected ${params.mediaType} format.`
        ),
        { statusCode: 422 }
      );
    }

    const resolvedMime =
      downloadRes.headers.get("content-type")?.split(";")[0]?.trim() || meta.mimeType;

    return {
      buffer,
      mimeType: resolvedMime,
      filename: meta.filename,
      mediaType: params.mediaType,
      providerName: provider.name,
      providerAssetId: params.providerAssetId,
      title: meta.title,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      creatorName: meta.creatorName,
      attributionUrl: meta.attributionUrl,
      licenseInfo: meta.licenseInfo,
      sourceUrl: meta.attributionUrl,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw Object.assign(
        new Error("Stock media download timed out before completing."),
        { statusCode: 504 }
      );
    }
    if ((err as { statusCode?: number })?.statusCode) {
      throw err;
    }
    throw Object.assign(
      new Error(
        sanitizeErrorMessage(
          err instanceof Error ? err.message : "Failed to import stock media."
        )
      ),
      { statusCode: 502 }
    );
  } finally {
    clearTimeout(timeout);
    activeStockImportCount = Math.max(0, activeStockImportCount - 1);
  }
}
