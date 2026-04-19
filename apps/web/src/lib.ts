const apiBase = import.meta.env.VITE_API_BASE || "/api";

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function formatOutput(output: Record<string, unknown> | null): string {
  if (!output) {
    return "No structured output recorded yet.";
  }

  const lines = Object.entries(output).map(([key, value]) =>
    `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`
  );
  return lines.join("\n");
}