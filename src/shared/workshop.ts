// Workshop helpers used by both processes.

export const workshopUrl = (id: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`

/** Accepts bare ids, Workshop URLs and steam:// links, separated by anything. */
export function parseWorkshopIds(text: string): string[] {
  const ids = new Set<string>()
  for (const m of text.matchAll(/(?:[?&]id=|CommunityFilePage\/|\b)(\d{6,12})\b/g)) ids.add(m[1])
  return [...ids]
}
