import React from "react";
import SearchBar from "./SearchBar";

export default function ActivityTable({
  kicker,
  title,
  description,
  headingAction,
  searchLabel,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  children,
}) {
  return (
    <section className="activity-card card">
      <div className="activity-heading">
        <div>
          <div className="card-kicker">{kicker}</div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {headingAction}
      </div>
      <div className="activity-tabs">
        <SearchBar
          className="activity-search"
          label={searchLabel}
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={onSearchChange}
        />
      </div>
      {children}
    </section>
  );
}
