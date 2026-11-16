/** Metadata display preferences are also loaded before any document is opened. */
export interface MetadataDisplayField {
  key: string;
  label: string;
  values: Record<string, string>;
}

export function validateMetadataFields(value: unknown): MetadataDisplayField[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error("fields");
  const keys = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("field");
    const field = item as MetadataDisplayField;
    if (
      typeof field.key !== "string" ||
      !field.key.trim() ||
      field.key.length > 128 ||
      typeof field.label !== "string" ||
      field.label.length > 128
    )
      throw new Error("field");
    if (keys.has(field.key)) throw new Error("duplicate");
    keys.add(field.key);
    const values = field.values ?? {};
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.keys(values).length > 32 ||
      Object.entries(values).some(
        ([key, val]) => key.length > 128 || typeof val !== "string" || val.length > 128
      )
    )
      throw new Error("values");
    return { key: field.key, label: field.label, values: { ...values } };
  });
}
