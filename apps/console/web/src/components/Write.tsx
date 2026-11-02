/**
 * The state of Martin's writes, for the components that make them: `useWrite`, over `write.ts`, and signing out. What
 * they say in words is in `Words.tsx`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { doorHref, leave, post, said } from '../admin.ts';
import { IDLE, type WriteState, writer } from '../write.ts';
import { useStepUp } from './StepUp.tsx';

/**
 * Martin's writes from one place on the page: `send` one, `busy` while it is under way, `refusal` what the service
 * refused or warned of, and whether his passkey is `fresh`, for the key after a label. With no token (a visitor)
 * nothing is sent.
 */
export function useWrite(token: string | undefined) {
  const stepUp = useStepUp();
  const [state, show] = useState<WriteState>(IDLE);
  const now = useRef({ token, stepUp });
  now.current = { token, stepUp };
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const { send, say } = useMemo(
    () =>
      writer({
        token: () => now.current.token,
        stepUp: () => now.current.stepUp,
        live: () => live.current,
        show,
      }),
    [],
  );
  return { ...state, send, say, fresh: stepUp.fresh };
}

/**
 * Signing out, here or everywhere, from the account menu or the settings: through `leave`, so nothing else sends the
 * page to another door on the way. A session that had ended already (signed out elsewhere, or its passkey revoked)
 * holds none in this browser either, though only a sign-out that went through ended every other. It stays busy once
 * it goes, as the page leaves.
 */
export function useSignOut(token: string) {
  const [state, show] = useState<WriteState>(IDLE);
  const signOut = async (everywhere: boolean) => {
    show({ busy: true, refusal: undefined });
    const got = await post(everywhere ? '/admin/sign-out-everywhere' : '/admin/sign-out', {}, token);
    if (got.status === 200 || got.status === 401) {
      leave(doorHref('sign-in', got.status === 200 && everywhere ? 'everywhere' : 'here'));
      return;
    }
    show({ busy: false, refusal: said(got) });
  };
  return { ...state, signOut };
}
