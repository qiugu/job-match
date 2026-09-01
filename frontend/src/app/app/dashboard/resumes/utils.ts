export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const toString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
