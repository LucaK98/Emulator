/// <reference lib="webworker" />
/** Worker entry point for the Game Boy Advance core. */

import { startWorkerRuntime } from '../runtime';
import { createGbaCore } from './gbaCore';

startWorkerRuntime(createGbaCore);
