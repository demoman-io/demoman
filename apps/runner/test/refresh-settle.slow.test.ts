// The refresh lane, part 6 of 6: its false alarms, one picture test per
// cause (spec 2026-11-10, "Tests that must be able to fail";
// `refresh-suite.ts` says why the lane is split).
//
// DEM-82's typing on a throttled CPU is not a case here: it could not
// fail. With the CPU at 4x around a type step, the screen after it showed
// the last character with the settle's paint round trip removed, the beat
// at 200 ms and at 20 ms alike (measured 2026-11-11). So that condition has
// no picture test. DEM-82 was found on screencast frames; a page screen is
// `Page.captureScreenshot`, which may draw a frame of its own, the likely
// reason it never missed the key.
import {
  caret,
  debounce,
  hover,
  lazyModule,
  neverSettles,
  refreshSuite,
  spinner,
  stream,
  toast,
} from "./refresh-suite.js";

refreshSuite(
  caret,
  hover,
  spinner,
  stream,
  lazyModule,
  toast,
  debounce,
  neverSettles,
);
