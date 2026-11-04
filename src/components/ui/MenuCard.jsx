import { Children, useId } from "react";

/**
 * Settings card: a header strip (title, subtitle, optional action on the right) above the body.
 * `as` sets the root element (section, form, fieldset…); other props (aria-*, onSubmit, noValidate…)
 * go to the root. Without an aria-label the card is labelled by its title.
 */
const MenuCard = ({ as: Root = "section", children, title, subtitle, action, titleAs: Title = "h2", titleId, className = "", bodyClassName = "", ...rest }) => {
  const autoId = useId();
  const headingId = titleId ?? `${autoId}-title`;
  const hasBody = Children.toArray(children).length > 0;
  const labelled = title && !rest["aria-label"] && !rest["aria-labelledby"] ? { "aria-labelledby": headingId } : {};
  return (
    <Root {...labelled} {...rest} className={`flex min-w-0 flex-col rounded-2xl border border-border-color bg-secondary-bg ${className}`}>
      {title || subtitle || action ? (
        <div className={`flex items-start justify-between gap-3 p-5 py-3 ${hasBody ? "border-b border-border-color" : ""}`}>
          <div className="min-w-0">
            {title && (
              <Title id={headingId} className="text-lg font-semibold text-primary-text">
                {title}
              </Title>
            )}
            {subtitle && <p className="text-xs text-tertiary-text">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      ) : null}
      {hasBody && <div className={`p-5 ${bodyClassName}`}>{children}</div>}
    </Root>
  );
};

export default MenuCard;
