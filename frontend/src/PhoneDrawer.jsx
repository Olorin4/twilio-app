import React, { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function PhoneDrawer({
  open,
  ringing,
  onClose,
  callControls,
  children,
}) {
  const panel = useRef(null);
  const body = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current;
    const opener = document.activeElement;
    const overflow = document.body.style.overflow;
    const mobile = window.matchMedia("(max-width: 599px)");
    document.body.style.overflow = "hidden";
    element.querySelector(".phone-drawer-close").focus({ preventScroll: true });
    const keydown = (event) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab" || !mobile.matches) return;
      const controls = [
        ...element.querySelectorAll(
          "button:not(:disabled), input:not(:disabled), textarea, select, a[href], summary",
        ),
      ].filter(
        (control) =>
          control.getClientRects().length && !control.closest("[inert]"),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const outside = (event) => {
      if (
        !element.contains(event.target) &&
        !event.target.closest?.("[data-phone-opener]")
      )
        close.current();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
      if (
        element.contains(document.activeElement) ||
        document.activeElement === document.body
      ) {
        const target =
          opener instanceof HTMLElement &&
          opener.isConnected &&
          opener !== document.body
            ? opener
            : document.querySelector(".phone-launcher");
        target?.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !ringing) return;
    body.current.scrollTop = 0;
    panel.current
      .querySelector("[data-answer-call]")
      ?.focus({ preventScroll: true });
  }, [open, ringing]);

  return createPortal(
    <aside
      id="phone-drawer"
      ref={panel}
      role="dialog"
      aria-labelledby="phone-drawer-title"
      aria-hidden={!open}
      inert={!open}
      className={`phone-drawer ${open ? "phone-drawer-open" : ""}`}
    >
      <header>
        <h2 id="phone-drawer-title">Phone</h2>
        {callControls}
        <button
          className="icon-button phone-drawer-close"
          type="button"
          onClick={onClose}
          aria-label="Close phone drawer"
        >
          <X size={20} />
        </button>
      </header>
      <div className="phone-drawer-body" ref={body}>
        {children}
      </div>
    </aside>,
    document.body,
  );
}
