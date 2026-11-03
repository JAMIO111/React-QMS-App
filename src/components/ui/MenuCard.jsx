const MenuCard = ({ children, title, subtitle }) => {
  return (
    <div className="flex flex-col bg-secondary-bg rounded-2xl border border-border-color">
      {title || subtitle ? (
        <div className="border-b border-border-color p-5 py-3">
          {title && (
            <p className="text-primary-text font-semibold text-lg">{title}</p>
          )}
          {subtitle && <p className="text-tertiary-text text-xs">{subtitle}</p>}
        </div>
      ) : null}
      <div className="p-5"> {children}</div>
    </div>
  );
};

export default MenuCard;
