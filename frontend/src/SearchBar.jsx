import React from "react";
import { Search } from "lucide-react";

export default function SearchBar({
  value,
  onChange,
  label,
  placeholder = "Search",
  className = "",
}) {
  return (
    <div className={`search ${className}`}>
      <Search size={15} aria-hidden="true" />
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
