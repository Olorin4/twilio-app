// Reads the answer to a message send. A proxy in front of the app (Cloudflare)
// can answer with its own HTML page instead of the app's JSON; that is
// reported plainly, since whether the message went out is then unknown.
export async function readSendResult(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Could not confirm whether the message was sent (HTTP ${response.status}). Check Twilio before retrying.`,
    );
  }
  if (!response.ok)
    throw new Error(data?.error || "Could not send the message.");
  return data;
}
