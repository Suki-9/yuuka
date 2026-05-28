/**
 * A highly-robust, zero-dependency YAML parser.
 * Supports:
 * - Simple flat key-value pairs (KEY: VALUE)
 * - Strip double or single quotes
 * - Multi-line block strings using `|` notation with proper indentation
 * - Comment stripping (#) and empty line skipping
 */
export function parseYaml(content: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = content.split(/\r?\n/);

  let currentKey: string | null = null;
  let blockLines: string[] = [];
  let blockIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If we are currently parsing a multi-line block string
    if (currentKey !== null) {
      if (line.trim() === "") {
        blockLines.push("");
        continue;
      }

      const matchIndent = line.match(/^(\s*)/);
      const indent = matchIndent ? matchIndent[1].length : 0;

      if (indent > blockIndent || (indent === blockIndent && line.trim().length > 0)) {
        blockLines.push(line.substring(blockIndent));
        continue;
      } else {
        // End of the multi-line block
        result[currentKey] = blockLines.join("\n");
        currentKey = null;
        blockLines = [];
        blockIndent = 0;
        // Fall through to parse this line as a normal line
      }
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    const valuePart = line.substring(colonIndex + 1).trim();

    if (valuePart === "|") {
      currentKey = key;
      // Lookahead to find the indent level of the first non-empty line
      let nextLineIndex = i + 1;
      while (nextLineIndex < lines.length && lines[nextLineIndex].trim() === "") {
        nextLineIndex++;
      }
      if (nextLineIndex < lines.length) {
        const nextLine = lines[nextLineIndex];
        const matchIndent = nextLine.match(/^(\s*)/);
        blockIndent = matchIndent ? matchIndent[1].length : 2;
      } else {
        blockIndent = 2;
      }
      blockLines = [];
    } else if (valuePart === "") {
      // Check if subsequent lines are a list/array starting with "-"
      let nextLineIndex = i + 1;
      const listItems: string[] = [];
      let isList = false;

      while (nextLineIndex < lines.length) {
        const nextLine = lines[nextLineIndex];
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed) {
          nextLineIndex++;
          continue;
        }
        if (nextTrimmed.startsWith("#")) {
          nextLineIndex++;
          continue;
        }

        // A list item starts with a hyphen
        if (nextTrimmed.startsWith("-")) {
          isList = true;
          let itemVal = nextTrimmed.substring(1).trim();
          // Strip quotes
          if (itemVal.startsWith('"') && itemVal.endsWith('"')) {
            itemVal = itemVal.substring(1, itemVal.length - 1);
          } else if (itemVal.startsWith("'") && itemVal.endsWith("'")) {
            itemVal = itemVal.substring(1, itemVal.length - 1);
          }
          listItems.push(itemVal);
          nextLineIndex++;
        } else {
          break;
        }
      }

      if (isList) {
        result[key] = listItems;
        i = nextLineIndex - 1; // Advance loop past the list lines
      } else {
        result[key] = "";
      }
    } else {
      let val = valuePart;
      // Strip outer quotes
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.substring(1, val.length - 1);
        // Standard YAML strings can contain escaped newlines
        val = val.replace(/\\n/g, "\n");
      } else if (val.startsWith("'") && val.endsWith("'")) {
        val = val.substring(1, val.length - 1);
        val = val.replace(/\\n/g, "\n");
      }
      result[key] = val;
    }
  }

  // If file ends while inside a block
  if (currentKey !== null) {
    result[currentKey] = blockLines.join("\n");
  }

  return result;
}
