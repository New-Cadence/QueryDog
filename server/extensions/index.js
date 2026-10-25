// Convoy server extensions. Each area keeps its routes and
// background work in its own module so server/index.js only needs a
// single hook. Every module exports `register(app, ctx)`.
import fs from 'fs';
import path from 'path';
import * as alerting from './alerting.js';
import * as notebooks from './notebooks.js';
import * as dictionary from './dictionary.js';
import * as cost from './cost.js';
import * as dataquality from './dataquality.js';
import * as silences from './silences.js';
import * as settings from './settings.js';

/**
 * @param {import('express').Express} app
 * @param {object} ctx
 * @param {() => import('@clickhouse/client').ClickHouseClient} ctx.getClient  Current client (changes on env switch)
 * @param {() => object} ctx.getActiveEnvironment  Active environment config (name, host, deployment, ...)
 * @param {() => string} ctx.getAlertsPath
 * @param {(kind: 'monitoring' | 'alerts' | 'performance' | 'dataquality') => string} ctx.getClientFolder  Folder for a class of client checks
 * @param {(folder: string, sqlFilename: string) => string} ctx.readDescription
 * @param {(type: string, filename: string, entry: object) => void} ctx.recordRun
 * @param {() => object} [ctx.getSchedulerStatus]  Read-only scheduler status (server/scheduler.js)
 */
export function registerExtensions(app, ctx) {
  const dataDir = process.env.QUERYDOG_DATA_DIR || path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const fullCtx = { ...ctx, dataDir };
  for (const mod of [alerting, notebooks, dictionary, cost, dataquality, silences, settings]) {
    mod.register(app, fullCtx);
  }
}
