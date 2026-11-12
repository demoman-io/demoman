// The refresh lane, part 3 of 6 (`refresh-suite.ts` says why it is split).
import {
  clickGuard,
  firstFilm,
  refreshSuite,
  replaceChain,
} from "./refresh-suite.js";

refreshSuite(firstFilm, replaceChain, clickGuard);
