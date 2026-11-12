// The refresh lane, part 4 of 6 (`refresh-suite.ts` says why it is split):
// videos kept on their own, which never read the first film.
import {
  gifAlone,
  logoOrUpload,
  refreshSuite,
  shortEnding,
  upload,
} from "./refresh-suite.js";

refreshSuite(shortEnding, gifAlone, upload, logoOrUpload);
