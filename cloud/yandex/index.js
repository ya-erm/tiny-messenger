// Cloud Functions entrypoint, independent of the package's module loader mode.
exports.handler = async (event, context) => (await import("./src/handler.mjs")).handler(event, context);
