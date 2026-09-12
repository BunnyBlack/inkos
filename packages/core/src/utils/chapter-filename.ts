/** Match the complete leading chapter number, including legacy unpadded filenames. */
export function chapterNumberFromFilename(filename: string): number | undefined {
  const match = /^(\d+)[_-]?.*\.md$/.exec(filename);
  if (!match) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
