import React from "react";

export default function Pagination({
  label,
  page,
  pageSize,
  hasMore,
  loading = false,
  onPageChange,
  onPageSizeChange,
}) {
  return (
    <nav className="activity-pagination" aria-label={label}>
      <label className="page-size">
        Rows per page
        <select
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {[10, 20, 50].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <span>Page {page}</span>
      <div className="page-navigation">
        <button
          className="button button-light"
          disabled={page === 1 || loading}
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <button
          className="button button-light"
          disabled={!hasMore || loading}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
