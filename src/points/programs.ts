/** BAM's programs (docs/bam.md): the miles and points currencies Minty knows by name. Code, never
 * fetched at runtime. A program not listed here can still be typed in by its name. M2 adds the
 * patterns that recognise each one on a statement, and M3 which cards earn it and its expiry
 * rule, each with a source. Names as each program writes them on its own site, on CHECKED. */

export const CHECKED = "2026-10-16";

export type Kind = "bank" | "airline" | "hotel";

export interface Program {
  id: string;
  name: string;
  kind: Kind;
  unit: string;                                  // what a balance counts: points, miles, Avios
  site: string;                                  // where the program names itself
}

export const PROGRAMS: readonly Program[] = [
  { id: "amex_mr", name: "Amex Membership Rewards", kind: "bank", unit: "points", site: "americanexpress.com" },
  { id: "chase_ur", name: "Chase Ultimate Rewards", kind: "bank", unit: "points", site: "chase.com" },
  { id: "citi_typ", name: "Citi ThankYou Points", kind: "bank", unit: "points", site: "citi.com" },
  { id: "capital_one", name: "Capital One Miles", kind: "bank", unit: "miles", site: "capitalone.com" },
  { id: "bilt", name: "Bilt Rewards", kind: "bank", unit: "points", site: "biltrewards.com" },
  { id: "united", name: "United MileagePlus", kind: "airline", unit: "miles", site: "united.com" },
  { id: "delta", name: "Delta SkyMiles", kind: "airline", unit: "miles", site: "delta.com" },
  { id: "american", name: "American AAdvantage", kind: "airline", unit: "miles", site: "aa.com" },
  { id: "southwest", name: "Southwest Rapid Rewards", kind: "airline", unit: "points", site: "southwest.com" },
  { id: "jetblue", name: "JetBlue TrueBlue", kind: "airline", unit: "points", site: "jetblue.com" },
  { id: "aeroplan", name: "Air Canada Aeroplan", kind: "airline", unit: "points", site: "aircanada.com" },
  { id: "ba_avios", name: "British Airways Avios", kind: "airline", unit: "Avios", site: "britishairways.com" },
  { id: "marriott", name: "Marriott Bonvoy", kind: "hotel", unit: "points", site: "marriott.com" },
  { id: "hilton", name: "Hilton Honors", kind: "hotel", unit: "points", site: "hilton.com" },
  { id: "hyatt", name: "World of Hyatt", kind: "hotel", unit: "points", site: "hyatt.com" },
  { id: "ihg", name: "IHG One Rewards", kind: "hotel", unit: "points", site: "ihg.com" },
];

export const PROGRAM_BY_ID: ReadonlyMap<string, Program> = new Map(PROGRAMS.map((p) => [p.id, p]));
