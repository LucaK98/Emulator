/// <reference lib="webworker" />
/** Worker entry point for the Game Boy / Game Boy Color core. */

import { startWorkerRuntime } from '../runtime';
import { createGbCore } from './gbCore';

startWorkerRuntime(createGbCore);
