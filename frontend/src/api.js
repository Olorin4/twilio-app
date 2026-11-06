export const IRON_WING_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
let currentWorkspace = IRON_WING_WORKSPACE_ID;

export function setApiWorkspace(id) {
  currentWorkspace = id;
}
export function getApiWorkspace() {
  return currentWorkspace;
}

export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("X-Workspace-Id"))
    headers.set("X-Workspace-Id", currentWorkspace);
  return fetch(url, { ...options, headers });
}
