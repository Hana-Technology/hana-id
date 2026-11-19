// Imported first by admin-lane-worker.ts: the lane's clock (lane-clock.ts) is in place before any other module runs.
import { installLaneClock } from './lane-clock.ts';

installLaneClock();
