// Which registered phone an owner calls and texts from in a workspace: the
// active line's connection, or for Iron Wing with no line chosen the legacy
// phone, unless the main number is moved into the connection (then none, so
// the phone shows no line instead of calling from the main number).
export function ownerVoiceKey(workspace, ironWingId) {
  if (workspace?.active_connection_id)
    return workspace.active_voice_enabled === false
      ? null
      : workspace.active_connection_id;
  return workspace?.id === ironWingId && !workspace.legacy_moved
    ? "legacy"
    : null;
}
