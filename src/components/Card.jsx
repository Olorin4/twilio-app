import React from "react";

export function Card({ children, ...props }) {
  return (
    <div {...props} style={{ border: "1px solid #ccc", borderRadius: "8px", padding: "16px", backgroundColor: "#fff", marginBottom: "16px" }}>
      {children}
    </div>
  );
}

export function CardContent({ children, ...props }) {
  return (
    <div {...props}>
      {children}
    </div>
  );
}
