const HeaderIcon = ({ icon: Icon, top, right, showBadge }) => {
  return (
    <div className="relative p-2 bg-tertiary-bg shadow-s hover:shadow-m flex items-center justify-center w-10 h-10 rounded-xl cursor-pointer">
      <Icon className="h-7 w-7 fill-icon-color hover:fill-primary-text" />
      {showBadge && (
        <span
          style={{ top: `${top}px`, right: `${right}px` }}
          className={`absolute w-2.5 h-2.5 border-1 border-secondary-bg rounded-full bg-error-color`}></span>
      )}
    </div>
  );
};

export default HeaderIcon;
