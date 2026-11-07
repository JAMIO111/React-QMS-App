const HeaderIcon = ({ icon: Icon, top, right, showBadge }) => {
  return (
    <div className="group relative p-2 bg-tertiary-bg shadow-s hover:shadow-m flex items-center justify-center w-9 h-9 rounded-lg cursor-pointer">
      <Icon className="h-5.5 w-5.5 text-icon-color group-hover:text-primary-text" />
      {showBadge && (
        <span
          style={{ top: `${top}px`, right: `${right}px` }}
          className={`absolute w-2.5 h-2.5 border-1 border-secondary-bg rounded-full bg-error-color`}></span>
      )}
    </div>
  );
};

export default HeaderIcon;
