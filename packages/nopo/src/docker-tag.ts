import { z } from "zod";

const VERSION_PATTERN = /^(?![.-])[a-zA-Z0-9_.-]{1,128}$/;
const DIGEST_PATTERN = /^sha256:[a-fA-F0-9]{64}$/;

const DockerTagParsed = z.object({
  registry: z.string(),
  image: z.string(),
  version: z.string(),
  digest: z.string().optional().default(""),
});

type DockerTagParsedType = z.infer<typeof DockerTagParsed>;

interface DockerTagInput {
  registry?: string;
  image: string;
  version?: string;
  digest?: string | undefined;
}

export class DockerTag {
  parsed: DockerTagParsedType;
  fullTag: string;

  /** Handles registries with ports (e.g., localhost:5000/image:tag). Registry is detected
   * when the part before the first "/" contains "." or ":" or equals "localhost" (matching
   * Docker's reference spec).
   */
  static parse(fullTag: string): DockerTagParsedType {
    let remaining = fullTag;

    // 1. Extract @sha256:... digest
    let digest = "";
    const atIndex = remaining.lastIndexOf("@");
    if (atIndex !== -1) {
      const candidate = remaining.slice(atIndex + 1);
      if (DIGEST_PATTERN.test(candidate)) {
        digest = candidate;
        remaining = remaining.slice(0, atIndex);
      }
    }

    // 2. Extract :version — last ":" that comes after the last "/"
    let version = "";
    const lastSlash = remaining.lastIndexOf("/");
    const lastColon = remaining.lastIndexOf(":");
    if (lastColon > lastSlash) {
      const candidate = remaining.slice(lastColon + 1);
      if (VERSION_PATTERN.test(candidate)) {
        version = candidate;
        remaining = remaining.slice(0, lastColon);
      }
    }

    // 3. Detect registry — part before first "/" if it looks like a host
    let registry = "";
    let image = remaining;
    const firstSlash = remaining.indexOf("/");
    if (firstSlash !== -1) {
      const firstPart = remaining.slice(0, firstSlash);
      if (
        firstPart.includes(".") ||
        firstPart.includes(":") ||
        firstPart === "localhost"
      ) {
        registry = firstPart;
        image = remaining.slice(firstSlash + 1);
      }
    }

    if (!image) {
      throw new Error(`Invalid image tag: ${fullTag} (image is required)`);
    }

    // Image must not contain unresolved ":" or "@" — indicates malformed input
    // (e.g., trailing colon, invalid digest that wasn't extracted)
    if (image.includes(":") || image.includes("@")) {
      throw new Error(`Invalid image tag: ${fullTag}`);
    }

    if (image === "sha256") {
      throw new Error(
        `Cannot parse image with only a digest: ${fullTag}. Include an image and version`,
      );
    }

    return DockerTagParsed.parse({
      registry,
      image,
      version,
      digest: digest || "",
    });
  }

  static stringify({
    registry,
    image,
    version,
    digest,
  }: DockerTagParsedType): string {
    let fullTag = "";
    if (registry) {
      fullTag = `${registry}/${image}`;
    } else {
      fullTag = image;
    }

    if (version) {
      fullTag += `:${version}`;
    }

    if (digest) {
      fullTag += `@${digest}`;
    }

    return fullTag;
  }

  constructor(tag: string | DockerTagInput) {
    if (typeof tag === "string") {
      this.parsed = DockerTag.parse(tag);
    } else if (typeof tag === "object") {
      this.parsed = DockerTagParsed.parse({
        registry: tag.registry || "",
        image: tag.image,
        version: tag.version || "",
        digest: tag.digest,
      });
    } else {
      throw new Error(`Invalid tag: ${tag}`);
    }
    this.fullTag = DockerTag.stringify(this.parsed);
  }
}
