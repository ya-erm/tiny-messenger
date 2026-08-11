import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(
  process.env.MESSENGER_DATA_FILE || path.join(process.cwd(), "data", "store.json"),
);
const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
const store = JSON.parse(await readFile(file, "utf8"));
let migratedMessages = 0;

for (const message of store.messages || []) {
  if (!Array.isArray(message.options)) continue;

  let migrated = false;
  let selectedIndex = null;
  if (message.answer && message.answer.side) {
    selectedIndex = message.answer.side === "right" ? 1 : 0;
  } else if (message.answer && Number.isInteger(message.answer.optionIndex)) {
    selectedIndex = message.answer.optionIndex;
  } else if (message.answer && typeof message.answer.id === "string") {
    selectedIndex = message.options.findIndex((option) => option?.id === message.answer.id);
    if (selectedIndex < 0 && /^\d+$/.test(message.answer.id)) {
      selectedIndex = Number(message.answer.id) - 1;
    }
  }

  const compactOptions = message.options.map((option, index) => ({
    id: String(index + 1),
    label: typeof option === "string" ? option : option?.label,
  }));
  if (compactOptions.some((option) => typeof option.label !== "string")) {
    throw new Error(`Message ${message.id} contains an invalid choice option`);
  }
  if (message.options.some((option, index) =>
    typeof option !== "object" || option?.id !== compactOptions[index].id || option?.label !== compactOptions[index].label
  )) {
    message.options = compactOptions;
    migrated = true;
  }

  if (message.answer && selectedIndex !== null) {
    const selected = message.options?.[selectedIndex];
    if (!selected) throw new Error(`Message ${message.id} answer points to a missing option`);
    const answerChanged = message.answer.id !== selected.id
      || message.answer.label !== selected.label
      || "side" in message.answer
      || "optionIndex" in message.answer;
    message.answer.id = selected.id;
    message.answer.label = selected.label;
    delete message.answer.side;
    delete message.answer.optionIndex;
    migrated ||= answerChanged;
  }
  if (migrated) migratedMessages += 1;
}

await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, file);
console.log(`Migrated ${migratedMessages} message(s) in ${file}`);
