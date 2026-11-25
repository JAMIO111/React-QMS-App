import { CircleHelpIcon, ExternalLinkIcon } from "@/components/icons";
import { helpUrl } from "../../lib/help";

/**
 * A link to a guide on the website, opened in a new tab: used beside the screens a guide explains (for example "How to write a formula" wherever an import
 * formula is typed). `topic` is a key of HELP_TOPICS' values (the guide's slug).
 */
const HelpLink = ({ topic, children, className = "" }) => (
  <a
    href={helpUrl(topic)}
    target="_blank"
    rel="noopener noreferrer"
    className={`inline-flex items-center gap-1 text-xs font-medium text-theme underline underline-offset-2 ${className}`}>
    <CircleHelpIcon aria-hidden="true" />
    {children}
    <ExternalLinkIcon aria-hidden="true" className="opacity-70" />
    <span className="sr-only"> (opens in a new tab)</span>
  </a>
);

export default HelpLink;
