export function clipboardFiles(data: DataTransfer): File[] {
  // items and files describe the same payload: choose one list so a browser
  // exposing both does not upload the same screenshot twice.
  const items = Array.from(data.items).filter((item) => item.kind === "file")
    .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
  return (items.length ? items : Array.from(data.files)).map((file) => {
    if (file.name) return file;
    const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const name = extension[file.type] ? `Вставленное изображение.${extension[file.type]}` : "Вставленный файл";
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}
