import React from "react";
import { useLocation, Link } from "react-router-dom";
import { breadcrumbIcon, looksLikeId, useBreadcrumbEntries } from "../lib/breadcrumbs";
import { LayoutDashboardIcon } from "@/components/icons";

// Utility: convert "non-conformance" → "Non Conformance"
function formatSegment(segment) {
  return segment
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function splitPath(pathname) {
  return pathname.split("/").filter(Boolean);
}

const CrumbIcon = ({ path }) => {
  const Icon = breadcrumbIcon(path);
  return <Icon aria-hidden="true" />;
};

const Breadcrumb = () => {
  const location = useLocation();
  const segments = splitPath(location.pathname);
  const names = useBreadcrumbEntries();

  return (
    <nav className="flex items-center gap-1 text-sm text-secondary-text font-semibold">
      <LayoutDashboardIcon />
      <Link to="/Dashboard" className="hover:underline">
        Home
      </Link>
      {segments.map((segment, index) => {
        const path = "/" + segments.slice(0, index + 1).join("/");
        const named = names.get(path);
        const raw = decodeURIComponent(segment);
        // A record's name, or a short wait mark: an id is never shown.
        const text = named?.label ?? (looksLikeId(raw) ? "…" : formatSegment(raw));
        return (
          <React.Fragment key={segment}>
            <span className="mx-1">/</span>
            <CrumbIcon path={path} />
            <Link to={named?.to ?? path} className={named?.label ? "hover:underline" : "hover:underline capitalize"}>
              {text}
            </Link>
          </React.Fragment>
        );
      })}
    </nav>
  );
};

export default Breadcrumb;
