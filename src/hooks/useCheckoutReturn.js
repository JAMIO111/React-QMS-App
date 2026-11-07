import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useConfirmCheckout } from "./useSubscription";

const RETRY_MS = 3000;
const MAX_ATTEMPTS = 10;

/**
 * Handles the person coming back from Stripe Checkout (`?checkout=success&session_id=…` or `?checkout=cancelled`). The address is cleaned at once.
 * On success it asks the server to check the session with Stripe (the redirect alone proves nothing), and checks again every few seconds while Stripe says the
 * person has not finished paying, up to about 30 seconds. phase: idle | confirming | waiting | done | cancelled | expired | timeout | failed.
 */
export const useCheckoutReturn = () => {
  const [params, setParams] = useSearchParams();
  const initial = useRef({ result: params.get("checkout"), sessionId: params.get("session_id") });
  const confirm = useConfirmCheckout();
  const starts = initial.current.result === "success" && initial.current.sessionId;
  const [phase, setPhase] = useState(starts ? "confirming" : initial.current.result === "cancelled" ? "cancelled" : "idle");
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const attempts = useRef(0);

  useEffect(() => {
    if (!initial.current.result) return;
    const next = new URLSearchParams(params);
    next.delete("checkout");
    next.delete("session_id");
    setParams(next, { replace: true });
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = phase === "confirming" || phase === "waiting";
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer;
    attempts.current += 1;
    confirm
      .mutateAsync({ sessionId: initial.current.sessionId })
      .then((res) => {
        if (cancelled) return;
        if (res.status === "complete") setPhase("done");
        else if (res.status === "expired") setPhase("expired");
        else if (attempts.current >= MAX_ATTEMPTS) setPhase("timeout");
        else {
          setPhase("waiting");
          timer = setTimeout(() => setTick((t) => t + 1), RETRY_MS);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e);
        setPhase("failed");
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The mutation object changes identity on every render; only the tick and whether we are active matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tick]);

  return {
    phase,
    error,
    retry: () => {
      attempts.current = 0;
      setError(null);
      setPhase("confirming");
      setTick((t) => t + 1);
    },
    dismiss: () => setPhase("idle"),
  };
};
