#!/usr/bin/env node
/** 入口只做一件事：把退出码交给进程。所有逻辑在 src/cli.js 里，方便测试。 */
import { run } from '../src/cli.js';

process.exitCode = await run(process.argv.slice(2));
