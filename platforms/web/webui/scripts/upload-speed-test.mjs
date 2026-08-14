import assert from 'node:assert/strict';
import { UploadSpeedTracker } from '../src/shared/uploadSpeed.js';

const MiB = 1024 * 1024;
const tracker = new UploadSpeedTracker({ windowMs: 5000, idleMs: 5000 });

tracker.record(0, 0);
tracker.record(2 * MiB, 2000);
assert.equal(tracker.getSpeed(2800), MiB, '800ms without a progress event must retain the rolling speed');
assert.equal(tracker.getSpeed(6999), MiB, 'speed remains stable until the idle threshold');
assert.equal(tracker.getSpeed(7000), 0, 'five seconds without progress is treated as a real stall');

tracker.record(3 * MiB, 8000);
assert.equal(tracker.getSpeed(8000), 0, 'the first event after a stall establishes a new baseline');
tracker.record(5 * MiB, 9000);
assert.equal(tracker.getSpeed(9000), 2 * MiB, 'speed recovers from post-stall progress samples');

tracker.reset();
tracker.record(10 * MiB, 1000);
tracker.record(11 * MiB, 2000);
tracker.record(13 * MiB, 4000);
tracker.record(16 * MiB, 7000);
assert.equal(tracker.getSpeed(7000), MiB, 'rolling samples produce the expected five-second average');

console.log('upload speed tracker tests passed');
