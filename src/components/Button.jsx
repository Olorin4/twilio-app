import React from "react";

export function Button({ onClick, children, type = "button", disabled = false, className = "" }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`basic-button ${className}`}
    >
      {children}
    </button>
  );
}
