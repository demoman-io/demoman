/** How many active links a free workspace may hold at once. */
export const FREE_LINK_LIMIT = 5;
/** The longest video a link may serve (the 10-minute placeholder, 10-23). */
export const MAX_VIDEO_SECONDS = 600;
export const MAX_UPLOAD_BYTES = 300_000_000;
/** Under Workers' 100 MB request body limit, with room. */
export const UPLOAD_PART_BYTES = 50_000_000;
export const MAX_POSTER_BYTES = 5_000_000;
