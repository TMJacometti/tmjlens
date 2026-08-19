/**
 * Removes terminal control sequences from container output.
 *
 * The viewer renders plain text, so escapes would otherwise show up as literal noise
 * like `[0;32m`. Stripping them also means a container cannot use cursor movement or
 * screen clearing to redraw what the operator is looking at.
 *
 * Covers the sequences that appear in ordinary program output: CSI (colour, cursor),
 * OSC (window title), and single-character escapes. Written as an explicit scan rather
 * than one regex because the OSC terminator is either BEL or ESC-backslash, which a
 * single pattern handles badly.
 */
const ESC = '';
const BEL = '';

export function stripAnsi(input: string): string {
  if (!input.includes(ESC) && !input.includes(BEL)) return input;

  let output = '';
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char !== ESC) {
      // A bare BEL is a beep, not content.
      if (char !== BEL) output += char;
      index += 1;
      continue;
    }

    const next = input[index + 1];

    if (next === '[') {
      // CSI: parameters, then a final byte in @ through ~.
      let cursor = index + 2;
      while (cursor < input.length && !/[@-~]/.test(input[cursor])) cursor += 1;
      index = cursor + 1;
    } else if (next === ']') {
      // OSC: runs until BEL or ESC \.
      let cursor = index + 2;
      while (cursor < input.length) {
        if (input[cursor] === BEL) {
          cursor += 1;
          break;
        }
        if (input[cursor] === ESC && input[cursor + 1] === '\\') {
          cursor += 2;
          break;
        }
        cursor += 1;
      }
      index = cursor;
    } else if (next === undefined) {
      // A trailing escape with nothing after it: drop it.
      index += 1;
    } else if (next >= ' ' && next <= '/') {
      // An intermediate byte (0x20–0x2F) means more follow until a final byte in
      // 0x30–0x7E — character-set selection such as ESC ( B is three characters,
      // not two, and stopping early would leave its final byte in the output.
      let cursor = index + 1;
      while (cursor < input.length && input[cursor] >= ' ' && input[cursor] <= '/') cursor += 1;
      index = cursor < input.length ? cursor + 1 : cursor;
    } else {
      // Two-character escape such as ESC c.
      index += 2;
    }
  }

  return output;
}
