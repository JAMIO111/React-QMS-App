const LoadingBar = () => {
  return (
    <div className="loader">
      <div className="loader-inner">
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
        <div className="loader-block"></div>
      </div>
      <div className="ml-2 text-secondary-text">Loading...</div>
    </div>
  );
};

export default LoadingBar;
