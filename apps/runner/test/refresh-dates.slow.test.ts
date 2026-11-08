// The refresh lane's pinned dates (DEM-79), a file of its own as each part of
// the lane is (`refresh-suite.ts` says why it is split).
import { pinnedDates, refreshSuite } from "./refresh-suite.js";

refreshSuite(pinnedDates);
