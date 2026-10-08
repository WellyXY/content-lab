export function assertFeishuSuccess(response: { code?: number | undefined; msg?: string | undefined }, operation: string): void {
  if (response.code !== 0) {
    throw new Error(`${operation} failed (${response.code ?? "missing code"}): ${response.msg ?? "unknown error"}`);
  }
}
