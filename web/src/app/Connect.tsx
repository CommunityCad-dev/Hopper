import { QrSvg } from './Qr';
import { formatCountdown, useLinkFlow } from './useLinkFlow';
import type { Status } from './types';

/**
 * Device-code sign-in (RFC 8628).
 *
 * The whole point of the flow: the printer never asks for credentials, because a
 * printer has no keyboard. It shows a short code, the user approves it on a phone
 * or laptop where they are already signed in, and the Pi picks up the token.
 */

interface Props {
  status: Status;
  onLinked: () => void;
  onBack: () => void;
}

export function Connect({ status, onLinked, onBack }: Props) {
  const { pending, starting, error, remaining, start, cancel } = useLinkFlow(status, onLinked);

  // If this browser linked another printer to an account, say so. Linking a second
  // printer is still a full approval, but knowing whose account it will join saves
  // the user wondering.
  const lastAccount = (() => {
    try {
      return localStorage.getItem('ccad:lastAccount');
    } catch {
      return null;
    }
  })();

  if (status.linked) {
    return (
      <div class="msg">
        <p>This printer is linked as {status.account?.username}.</p>
        <button class="btn" type="button" onClick={onBack}>Back to browsing</button>
      </div>
    );
  }

  return (
    <>
      <div class="head">
        <h2>Connect to CommunityCAD</h2>
      </div>

      {error && (
        <div class="msg warn" style="margin-bottom:14px">
          <p>{error}</p>
        </div>
      )}

      {!pending && (
        <div class="msg">
          <p>
            Sign in to CommunityCAD with Google or GitHub on your phone or computer, then
            approve a short code. Nothing is typed on the printer.
          </p>
          <p class="sub">
            Browsing works without an account. Sending and sharing need one: signing in with Google
            or GitHub is all it takes.
          </p>
          {lastAccount && (
            <p class="sub">Signed in on another printer as {lastAccount}.</p>
          )}
          <button class="btn" type="button" disabled={starting} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start sign-in'}
          </button>
        </div>
      )}

      {pending && (
        <div class="connect">
          <div class="code" aria-label="Your code">{pending.user_code}</div>
          <p>
            Go to <a href={pending.verification_uri} target="_blank" rel="noreferrer">
              {pending.verification_uri.replace(/^https?:\/\//, '')}
            </a>, sign in with Google or GitHub, and enter this code.
          </p>
          <QrSvg text={pending.verification_uri_complete} />
          <p class="sub">Or scan the code with your phone.</p>
          {remaining != null && (
            <p class="sub">
              {remaining > 0 ? `Expires in ${formatCountdown(remaining)}` : 'This code has expired.'}
            </p>
          )}
          <div class="foot" style="justify-content:center">
            <button class="btn ghost" type="button" onClick={() => void cancel()}>Cancel</button>
            {remaining === 0 && (
              <button class="btn" type="button" onClick={() => void start()}>Get a new code</button>
            )}
          </div>
        </div>
      )}

      <div class="more">
        <button class="btn ghost" type="button" onClick={onBack}>← Back to browsing</button>
      </div>
    </>
  );
}
