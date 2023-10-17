/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import type { ApplicationRef, Type } from '@angular/core';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { workerData } from 'node:worker_threads';
import type { extractRoutes } from '../../utils/routes-extractor/extractor';

export interface RoutesExtractorWorkerData {
  zonePackage: string;
  indexFile: string;
  outputPath: string;
  serverBundlePath: string;
}

interface ServerBundleExports {
  /** NgModule to render. */
  AppServerModule?: Type<unknown>;

  /** Standalone application bootstrapping function. */
  default?: (() => Promise<ApplicationRef>) | Type<unknown>;

  /** Method to extract routes from the router config. */
  extractRoutes: typeof extractRoutes;
}

const { zonePackage, serverBundlePath, outputPath, indexFile } =
  workerData as RoutesExtractorWorkerData;

async function extract(): Promise<string[]> {
  const {
    AppServerModule,
    extractRoutes,
    default: bootstrapAppFn,
  } = (await import(serverBundlePath)) as ServerBundleExports;

  const browserIndexInputPath = path.join(outputPath, indexFile);
  const document = await fs.promises.readFile(browserIndexInputPath, 'utf8');

  const bootstrapAppFnOrModule = bootstrapAppFn || AppServerModule;
  assert(
    bootstrapAppFnOrModule,
    `Neither an AppServerModule nor a bootstrapping function was exported from: ${serverBundlePath}.`,
  );

  const routes: string[] = [];
  for await (const { route, success } of extractRoutes(bootstrapAppFnOrModule, document)) {
    if (success) {
      routes.push(route);
    }
  }

  return routes;
}

/**
 * Initializes the worker when it is first created by loading the Zone.js package
 * into the worker instance.
 *
 * @returns A promise resolving to the extract function of the worker.
 */
async function initialize() {
  // Setup Zone.js
  await import(zonePackage);

  return extract;
}

/**
 * The default export will be the promise returned by the initialize function.
 * This is awaited by piscina prior to using the Worker.
 */
export default initialize();
