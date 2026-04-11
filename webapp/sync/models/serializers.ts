export const dateSerializer = (v: Date) => (v instanceof Date ? v.toISOString() : v);
export const dateDeserializer = (v: unknown) => new Date(v as string);
