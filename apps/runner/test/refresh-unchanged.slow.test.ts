// The refresh lane, part 1 of 6 (`refresh-suite.ts` says why it is split).
import {
  clickGuard,
  compareFailures,
  firstFilm,
  oneDigit,
  refreshSuite,
  unchangedThenSlower,
} from "./refresh-suite.js";

refreshSuite(
  firstFilm,
  unchangedThenSlower,
  oneDigit,
  compareFailures,
  clickGuard,
);
