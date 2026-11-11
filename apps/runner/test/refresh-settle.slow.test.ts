// The refresh lane's false alarms, one picture test per cause (spec
// 2026-11-10, "Tests that must be able to fail"); a file of its own as each
// part of the lane is (`refresh-suite.ts` says why it is split).
//
// DEM-82's typing on a throttled CPU is not a case here: a page screen is
// `Page.captureScreenshot`, which draws a fresh frame of the page as it is,
// so the last key was in it with or without the settle's paint round trip
// (measured 2026-11-11, CPU at 4x, with the beat at 200 ms and at 20 ms).
import {
  caret,
  debounce,
  hover,
  neverSettles,
  refreshSuite,
  spinner,
  stream,
  toast,
} from "./refresh-suite.js";

refreshSuite(caret, hover, spinner, stream, toast, debounce, neverSettles);
