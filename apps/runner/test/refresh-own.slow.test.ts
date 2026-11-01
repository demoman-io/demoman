// The refresh lane, part 4 of 4 (`refresh-suite.ts` says why it is split):
// videos kept on their own, which never read the first film.
import {
  gifAlone,
  logoOrUpload,
  refreshSuite,
  shortEnding,
  spinner,
  upload,
} from "./refresh-suite.js";

refreshSuite(shortEnding, gifAlone, spinner, upload, logoOrUpload);
