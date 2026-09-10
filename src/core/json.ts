/** Windows PowerShell's UTF-8 writer may prepend a BOM to otherwise valid JSON. */
export function parseJson(text: string) {
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}
