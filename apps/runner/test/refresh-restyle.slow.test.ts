// The refresh lane, part 2 of 4 (`refresh-suite.ts` says why it is split).
import {
  clickGuard,
  firstFilm,
  lookOutside,
  refreshSuite,
  restyles,
  wallpaperLeftOut,
} from "./refresh-suite.js";

refreshSuite(firstFilm, restyles, wallpaperLeftOut, lookOutside, clickGuard);
