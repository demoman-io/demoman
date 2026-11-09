// The names a user types or a registration carries (launch B rulings).
export const PACKAGE_NAME = "demoman";
export const MARKETPLACE_SOURCE = "demoman-io/plugins";
export const MARKETPLACE_NAME = "demoman";
export const PLUGIN_ID = "demoman@demoman";

/** "A", "A and B", "A, B and C". */
export const listed = (names: string[]): string =>
  names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
