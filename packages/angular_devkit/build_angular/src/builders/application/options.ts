/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import { BuilderContext } from '@angular-devkit/architect';
import type { Plugin } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  globalScriptsByBundleName,
  normalizeGlobalStyles,
} from '../../tools/webpack/utils/helpers';
import { normalizeAssetPatterns, normalizeOptimization, normalizeSourceMaps } from '../../utils';
import { I18nOptions, createI18nOptions } from '../../utils/i18n-options';
import { normalizeCacheOptions } from '../../utils/normalize-cache';
import { generateEntryPoints } from '../../utils/package-chunk-sort';
import { findTailwindConfigurationFile } from '../../utils/tailwind';
import { getIndexInputFile, getIndexOutputFile } from '../../utils/webpack-browser-config';
import { Schema as ApplicationBuilderOptions, I18NTranslation, OutputHashing } from './schema';

export type NormalizedApplicationBuildOptions = Awaited<ReturnType<typeof normalizeOptions>>;

/** Internal options hidden from builder schema but available when invoked programmatically. */
interface InternalOptions {
  /**
   * Entry points to use for the compilation. Incompatible with `browser`, which must not be provided. May be relative or absolute paths.
   * If given a relative path, it is resolved relative to the current workspace and will generate an output at the same relative location
   * in the output directory. If given an absolute path, the output will be generated in the root of the output directory with the same base
   * name.
   */
  entryPoints?: Set<string>;

  /** File extension to use for the generated output files. */
  outExtension?: 'js' | 'mjs';

  /**
   * Indicates whether all node packages should be marked as external.
   * Currently used by the dev-server to support prebundling.
   */
  externalPackages?: boolean;

  /**
   * Forces the output from the localize post-processing to not create nested directories per locale output.
   * This is only used by the development server which currently only supports a single locale per build.
   */
  forceI18nFlatOutput?: boolean;

  /**
   * Allows for usage of the deprecated `deployUrl` option with the compatibility builder `browser-esbuild`.
   */
  deployUrl?: string;
}

/** Full set of options for `application` builder. */
export type ApplicationBuilderInternalOptions = Omit<
  ApplicationBuilderOptions & InternalOptions,
  'browser'
> & {
  // `browser` can be `undefined` if `entryPoints` is used.
  browser?: string;
};

/**
 * Normalize the user provided options by creating full paths for all path based options
 * and converting multi-form options into a single form that can be directly used
 * by the build process.
 *
 * @param context The context for current builder execution.
 * @param projectName The name of the project for the current execution.
 * @param options An object containing the options to use for the build.
 * @param plugins An optional array of programmatically supplied build plugins.
 * @returns An object containing normalized options required to perform the build.
 */
// eslint-disable-next-line max-lines-per-function
export async function normalizeOptions(
  context: BuilderContext,
  projectName: string,
  options: ApplicationBuilderInternalOptions,
  plugins?: Plugin[],
) {
  const workspaceRoot = context.workspaceRoot;
  const projectMetadata = await context.getProjectMetadata(projectName);
  const projectRoot = normalizeDirectoryPath(
    path.join(workspaceRoot, (projectMetadata.root as string | undefined) ?? ''),
  );
  const projectSourceRoot = normalizeDirectoryPath(
    path.join(workspaceRoot, (projectMetadata.sourceRoot as string | undefined) ?? 'src'),
  );

  // Gather persistent caching option and provide a project specific cache location
  const cacheOptions = normalizeCacheOptions(projectMetadata, workspaceRoot);
  cacheOptions.path = path.join(cacheOptions.path, projectName);

  const i18nOptions: I18nOptions & {
    duplicateTranslationBehavior?: I18NTranslation;
    missingTranslationBehavior?: I18NTranslation;
  } = createI18nOptions(projectMetadata, options.localize);
  i18nOptions.duplicateTranslationBehavior = options.i18nDuplicateTranslation;
  i18nOptions.missingTranslationBehavior = options.i18nMissingTranslation;
  if (options.forceI18nFlatOutput) {
    i18nOptions.flatOutput = true;
  }

  const entryPoints = normalizeEntryPoints(workspaceRoot, options.browser, options.entryPoints);
  const tsconfig = path.join(workspaceRoot, options.tsConfig);
  const outputPath = normalizeDirectoryPath(path.join(workspaceRoot, options.outputPath));
  const optimizationOptions = normalizeOptimization(options.optimization);
  const sourcemapOptions = normalizeSourceMaps(options.sourceMap ?? false);
  const assets = options.assets?.length
    ? normalizeAssetPatterns(options.assets, workspaceRoot, projectRoot, projectSourceRoot)
    : undefined;

  const outputNames = {
    bundles:
      options.outputHashing === OutputHashing.All || options.outputHashing === OutputHashing.Bundles
        ? '[name]-[hash]'
        : '[name]',
    media:
      'media/' +
      (options.outputHashing === OutputHashing.All || options.outputHashing === OutputHashing.Media
        ? '[name]-[hash]'
        : '[name]'),
  };

  let fileReplacements: Record<string, string> | undefined;
  if (options.fileReplacements) {
    for (const replacement of options.fileReplacements) {
      fileReplacements ??= {};
      fileReplacements[path.join(workspaceRoot, replacement.replace)] = path.join(
        workspaceRoot,
        replacement.with,
      );
    }
  }

  const globalStyles: { name: string; files: string[]; initial: boolean }[] = [];
  if (options.styles?.length) {
    const { entryPoints: stylesheetEntrypoints, noInjectNames } = normalizeGlobalStyles(
      options.styles || [],
    );
    for (const [name, files] of Object.entries(stylesheetEntrypoints)) {
      globalStyles.push({ name, files, initial: !noInjectNames.includes(name) });
    }
  }

  const globalScripts: { name: string; files: string[]; initial: boolean }[] = [];
  if (options.scripts?.length) {
    for (const { bundleName, paths, inject } of globalScriptsByBundleName(options.scripts)) {
      globalScripts.push({ name: bundleName, files: paths, initial: inject });
    }
  }

  let tailwindConfiguration: { file: string; package: string } | undefined;
  const tailwindConfigurationPath = await findTailwindConfigurationFile(workspaceRoot, projectRoot);
  if (tailwindConfigurationPath) {
    // Create a node resolver at the project root as a directory
    const resolver = createRequire(projectRoot + '/');
    try {
      tailwindConfiguration = {
        file: tailwindConfigurationPath,
        package: resolver.resolve('tailwindcss'),
      };
    } catch {
      const relativeTailwindConfigPath = path.relative(workspaceRoot, tailwindConfigurationPath);
      context.logger.warn(
        `Tailwind CSS configuration file found (${relativeTailwindConfigPath})` +
          ` but the 'tailwindcss' package is not installed.` +
          ` To enable Tailwind CSS, please install the 'tailwindcss' package.`,
      );
    }
  }

  let indexHtmlOptions;
  // index can never have a value of `true` but in the schema it's of type `boolean`.
  if (typeof options.index !== 'boolean') {
    indexHtmlOptions = {
      input: path.join(workspaceRoot, getIndexInputFile(options.index)),
      // The output file will be created within the configured output path
      output: getIndexOutputFile(options.index),
      // TODO: Use existing information from above to create the insertion order
      insertionOrder: generateEntryPoints({
        scripts: options.scripts ?? [],
        styles: options.styles ?? [],
      }),
    };
  }

  let serverEntryPoint: string | undefined;
  if (options.server) {
    serverEntryPoint = path.join(workspaceRoot, options.server);
  } else if (options.server === '') {
    throw new Error('`server` option cannot be an empty string.');
  }

  let prerenderOptions;
  if (options.prerender) {
    const { discoverRoutes = true, routesFile = undefined } =
      options.prerender === true ? {} : options.prerender;

    prerenderOptions = {
      discoverRoutes,
      routesFile: routesFile && path.join(workspaceRoot, routesFile),
    };
  }

  let ssrOptions;
  if (options.ssr === true) {
    ssrOptions = {};
  } else if (typeof options.ssr === 'string') {
    ssrOptions = {
      entry: path.join(workspaceRoot, options.ssr),
    };
  }

  let appShellOptions;
  if (options.appShell) {
    appShellOptions = {
      route: 'shell',
    };
  }

  // Initial options to keep
  const {
    allowedCommonJsDependencies,
    aot,
    baseHref,
    crossOrigin,
    externalDependencies,
    extractLicenses,
    inlineStyleLanguage = 'css',
    outExtension,
    serviceWorker,
    poll,
    polyfills,
    preserveSymlinks,
    statsJson,
    stylePreprocessorOptions,
    subresourceIntegrity,
    verbose,
    watch,
    progress = true,
    externalPackages,
    deleteOutputPath,
    namedChunks,
    budgets,
    deployUrl,
  } = options;

  // Return all the normalized options
  return {
    advancedOptimizations: !!aot,
    allowedCommonJsDependencies,
    baseHref,
    cacheOptions,
    crossOrigin,
    deleteOutputPath,
    externalDependencies,
    extractLicenses,
    inlineStyleLanguage,
    jit: !aot,
    stats: !!statsJson,
    polyfills: polyfills === undefined || Array.isArray(polyfills) ? polyfills : [polyfills],
    poll,
    progress,
    externalPackages,
    // If not explicitly set, default to the Node.js process argument
    preserveSymlinks: preserveSymlinks ?? process.execArgv.includes('--preserve-symlinks'),
    stylePreprocessorOptions,
    subresourceIntegrity,
    serverEntryPoint,
    prerenderOptions,
    appShellOptions,
    ssrOptions,
    verbose,
    watch,
    workspaceRoot,
    entryPoints,
    optimizationOptions,
    outputPath,
    outExtension,
    sourcemapOptions,
    tsconfig,
    projectRoot,
    assets,
    outputNames,
    fileReplacements,
    globalStyles,
    globalScripts,
    serviceWorker:
      typeof serviceWorker === 'string' ? path.join(workspaceRoot, serviceWorker) : undefined,
    indexHtmlOptions,
    tailwindConfiguration,
    i18nOptions,
    namedChunks,
    budgets: budgets?.length ? budgets : undefined,
    publicPath: deployUrl ? deployUrl : undefined,
    plugins: plugins?.length ? plugins : undefined,
  };
}

/**
 * Normalize entry point options. To maintain compatibility with the legacy browser builder, we need a single `browser`
 * option which defines a single entry point. However, we also want to support multiple entry points as an internal option.
 * The two options are mutually exclusive and if `browser` is provided it will be used as the sole entry point.
 * If `entryPoints` are provided, they will be used as the set of entry points.
 *
 * @param workspaceRoot Path to the root of the Angular workspace.
 * @param browser The `browser` option pointing at the application entry point. While required per the schema file, it may be omitted by
 *     programmatic usages of `browser-esbuild`.
 * @param entryPoints Set of entry points to use if provided.
 * @returns An object mapping entry point names to their file paths.
 */
function normalizeEntryPoints(
  workspaceRoot: string,
  browser: string | undefined,
  entryPoints: Set<string> = new Set(),
): Record<string, string> {
  if (browser === '') {
    throw new Error('`browser` option cannot be an empty string.');
  }

  // `browser` and `entryPoints` are mutually exclusive.
  if (browser && entryPoints.size > 0) {
    throw new Error('Only one of `browser` or `entryPoints` may be provided.');
  }
  if (!browser && entryPoints.size === 0) {
    // Schema should normally reject this case, but programmatic usages of the builder might make this mistake.
    throw new Error('Either `browser` or at least one `entryPoints` value must be provided.');
  }

  // Schema types force `browser` to always be provided, but it may be omitted when the builder is invoked programmatically.
  if (browser) {
    // Use `browser` alone.
    return { 'main': path.join(workspaceRoot, browser) };
  } else {
    // Use `entryPoints` alone.
    const entryPointPaths: Record<string, string> = {};
    for (const entryPoint of entryPoints) {
      const parsedEntryPoint = path.parse(entryPoint);

      // Use the input file path without an extension as the "name" of the entry point dictating its output location.
      // Relative entry points are generated at the same relative path in the output directory.
      // Absolute entry points are always generated with the same file name in the root of the output directory. This includes absolute
      // paths pointing at files actually within the workspace root.
      const entryPointName = path.isAbsolute(entryPoint)
        ? parsedEntryPoint.name
        : path.join(parsedEntryPoint.dir, parsedEntryPoint.name);

      // Get the full file path to the entry point input.
      const entryPointPath = path.isAbsolute(entryPoint)
        ? entryPoint
        : path.join(workspaceRoot, entryPoint);

      // Check for conflicts with previous entry points.
      const existingEntryPointPath = entryPointPaths[entryPointName];
      if (existingEntryPointPath) {
        throw new Error(
          `\`${existingEntryPointPath}\` and \`${entryPointPath}\` both output to the same location \`${entryPointName}\`.` +
            ' Rename or move one of the files to fix the conflict.',
        );
      }

      entryPointPaths[entryPointName] = entryPointPath;
    }

    return entryPointPaths;
  }
}

/**
 * Normalize a directory path string.
 * Currently only removes a trailing slash if present.
 * @param path A path string.
 * @returns A normalized path string.
 */
function normalizeDirectoryPath(path: string): string {
  const last = path[path.length - 1];
  if (last === '/' || last === '\\') {
    return path.slice(0, -1);
  }

  return path;
}
