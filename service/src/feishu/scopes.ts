export const REQUIRED_FEISHU_SCOPES = [
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message.p2p_msg:readonly",
] as const;

export interface FeishuScopeState {
  scope_name: string;
  grant_status: number;
  scope_type?: "user" | "tenant" | undefined;
}

export function missingRequiredFeishuScopes(scopes: readonly FeishuScopeState[]): string[] {
  const granted = new Set(scopes
    .filter((scope) => scope.grant_status === 1 && (scope.scope_type === undefined || scope.scope_type === "tenant"))
    .map((scope) => scope.scope_name));
  return REQUIRED_FEISHU_SCOPES.filter((scope) => !granted.has(scope));
}
