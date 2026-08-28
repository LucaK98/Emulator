/// <reference lib="webworker" />
/** Worker entry point for the Nintendo DS core. */

import { startWorkerRuntime } from '../runtime';
import { createNdsCore } from './ndsCore';

startWorkerRuntime(createNdsCore);
