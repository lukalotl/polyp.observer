export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(
      response.status >= 500
        ? "Research service unavailable."
        : "This preview has no research API. Start the VM server, not a static preview.",
      response.status,
    );
  }
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof value?.error === "string"
        ? value.error
        : `Request failed (${response.status}).`,
      response.status,
    );
  return value as T;
}
export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
export function download(path: string, filename?: string) {
  const anchor = document.createElement("a");
  anchor.href = path;
  if (filename) anchor.download = filename;
  anchor.click();
}
