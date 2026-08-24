const CP1251_HIGH = 'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';

/** Repairs UTF-8 text that was accidentally decoded as Windows-1251. */
export function repairMojibake(value: string): string {
  if (!value || value.length < 2) return value;
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      bytes.push(code);
      continue;
    }
    const index = CP1251_HIGH.indexOf(character);
    if (index < 0) return value;
    bytes.push(index + 0x80);
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    if (decoded.length < value.length && /[А-Яа-яЁё]/.test(decoded)) return decoded;
  } catch {
    // Correct CP1251 text is normally invalid UTF-8 and must stay unchanged.
  }
  return value;
}
