import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookContext } from "@more-nopo/nopo/plugin";

import { generateDocusaurusConfig } from "./config-gen.ts";
import { generateSidebarContent } from "./sidebar.ts";
import type { DocsProjectConfig } from "./types.ts";
import { parseServiceConfig } from "./types.ts";

function copyMdFiles(srcDir: string, destDir: string): number {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".docusaurus" ||
        entry.name === "build" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      fs.mkdirSync(destPath, { recursive: true });
      count += copyMdFiles(srcPath, destPath);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function copySingleFile(srcPath: string, destDir: string): number {
  if (!fs.existsSync(srcPath)) return 0;
  const stat = fs.statSync(srcPath);
  if (!stat.isFile()) return 0;
  if (!srcPath.endsWith(".md") && !srcPath.endsWith(".mdx")) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, path.join(destDir, path.basename(srcPath)));
  return 1;
}

export class DocsCollector {
  private stagingDir: string;
  private docsDir: string;
  private rootDir: string;
  private siteDir: string;

  constructor(
    private context: HookContext,
    private config: DocsProjectConfig,
  ) {
    this.rootDir = context.runner.config.root;
    this.stagingDir = path.join(this.rootDir, ".docs-staging");
    this.docsDir = path.join(this.stagingDir, "docs");
    const thisFile = fileURLToPath(import.meta.url);
    this.siteDir = path.resolve(path.dirname(thisFile), "..", "site");
  }

  collect(): void {
    const logger = this.context.runner.logger;
    logger.log("Collecting documentation sources...");

    // Clean and recreate staging directory
    if (fs.existsSync(this.stagingDir)) {
      fs.rmSync(this.stagingDir, { recursive: true });
    }
    fs.mkdirSync(this.docsDir, { recursive: true });

    // Collect root-level docs
    let totalFiles = 0;
    for (const includePath of this.config.include) {
      const resolved = path.resolve(this.rootDir, includePath);

      if (!fs.existsSync(resolved)) {
        logger.log(`  Warning: include path not found: ${includePath}`);
        continue;
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        // Use the directory basename as the section name
        const sectionName = path.basename(resolved);
        const destDir = path.join(this.docsDir, sectionName);
        fs.mkdirSync(destDir, { recursive: true });
        const count = copyMdFiles(resolved, destDir);
        logger.log(
          `  Root: ${includePath} -> ${sectionName}/ (${count} files)`,
        );
        totalFiles += count;
      } else {
        // Single file goes into root of docs
        const count = copySingleFile(resolved, this.docsDir);
        logger.log(`  Root: ${includePath} (${count} files)`);
        totalFiles += count;
      }
    }

    // Collect service-level docs
    const services = this.context.runner.config.project.services.entries;
    for (const [serviceId, service] of Object.entries(services)) {
      if (!service.pluginData?.docs) continue;

      const serviceConfig = parseServiceConfig(service.pluginData.docs);
      const includePaths = serviceConfig.include ?? ["./docs"];

      for (const includePath of includePaths) {
        const resolved = path.resolve(service.paths.root, includePath);

        if (!fs.existsSync(resolved)) {
          logger.log(`  Service ${serviceId}: path not found: ${includePath}`);
          continue;
        }

        const stat = fs.statSync(resolved);
        const destDir = path.join(this.docsDir, serviceId);
        fs.mkdirSync(destDir, { recursive: true });

        if (stat.isDirectory()) {
          const count = copyMdFiles(resolved, destDir);
          logger.log(
            `  Service: ${serviceId} (${includePath}) -> ${serviceId}/ (${count} files)`,
          );
          totalFiles += count;
        } else {
          const count = copySingleFile(resolved, destDir);
          logger.log(
            `  Service: ${serviceId} (${includePath}) (${count} files)`,
          );
          totalFiles += count;
        }
      }
    }

    logger.log(`Collected ${totalFiles} documentation files.`);

    // Generate landing page if none exists
    if (!fs.existsSync(path.join(this.docsDir, "index.md"))) {
      fs.writeFileSync(
        path.join(this.docsDir, "index.md"),
        `---
slug: /
title: ${this.config.title}
---

# ${this.config.title}

Welcome to the project documentation.
`,
      );
    }

    // Generate Docusaurus config and sidebar
    this.generateConfig();
    this.generateSidebar();
    this.setupSymlinks();
  }

  private generateConfig(): void {
    const content = generateDocusaurusConfig(this.config);
    fs.writeFileSync(
      path.join(this.stagingDir, "docusaurus.config.ts"),
      content,
    );
  }

  private generateSidebar(): void {
    const content = generateSidebarContent(this.docsDir, this.config);
    fs.writeFileSync(path.join(this.stagingDir, "sidebars.ts"), content);
  }

  private setupSymlinks(): void {
    // Symlink src/ (CSS) from site directory
    const srcLink = path.join(this.stagingDir, "src");
    const srcTarget = path.join(this.siteDir, "src");
    if (!fs.existsSync(srcLink) && fs.existsSync(srcTarget)) {
      fs.symlinkSync(srcTarget, srcLink);
    }

    // Symlink static/ from site directory
    const staticLink = path.join(this.stagingDir, "static");
    const staticTarget = path.join(this.siteDir, "static");
    if (!fs.existsSync(staticLink) && fs.existsSync(staticTarget)) {
      fs.symlinkSync(staticTarget, staticLink);
    }

    // Symlink node_modules from site directory
    const nmLink = path.join(this.stagingDir, "node_modules");
    const nmTarget = path.join(this.siteDir, "node_modules");
    if (!fs.existsSync(nmLink) && fs.existsSync(nmTarget)) {
      fs.symlinkSync(nmTarget, nmLink);
    }

    // Copy package.json (Docusaurus needs it for module resolution)
    const pkgSrc = path.join(this.siteDir, "package.json");
    const pkgDest = path.join(this.stagingDir, "package.json");
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, pkgDest);
    }

    // Copy tsconfig.json
    const tsSrc = path.join(this.siteDir, "tsconfig.json");
    const tsDest = path.join(this.stagingDir, "tsconfig.json");
    if (fs.existsSync(tsSrc)) {
      fs.copyFileSync(tsSrc, tsDest);
    }
  }

  async build(): Promise<void> {
    const logger = this.context.runner.logger;
    logger.log("Building documentation site...");

    execFileSync("npx", ["docusaurus", "build"], {
      cwd: this.stagingDir,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });

    logger.log(`Build complete: ${path.join(this.stagingDir, "build")}`);
  }

  async dev(): Promise<void> {
    const logger = this.context.runner.logger;
    logger.log("Starting documentation dev server...");

    execFileSync(
      "npx",
      ["docusaurus", "start", "--port", "3333", "--host", "0.0.0.0"],
      {
        cwd: this.stagingDir,
        stdio: "inherit",
      },
    );
  }

  async serve(): Promise<void> {
    const buildDir = path.join(this.stagingDir, "build");
    if (!fs.existsSync(buildDir)) {
      throw new Error("No build found. Run 'nopo docs build' first.");
    }

    const logger = this.context.runner.logger;
    logger.log("Serving documentation site...");

    execFileSync(
      "npx",
      ["docusaurus", "serve", "--port", "3333", "--host", "0.0.0.0"],
      {
        cwd: this.stagingDir,
        stdio: "inherit",
      },
    );
  }
}
