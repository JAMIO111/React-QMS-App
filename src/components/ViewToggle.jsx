import { BsViewList, BsGrid } from "react-icons/bs";

const ViewToggle = ({ viewGrid, setViewGrid }) => {
  return (
    <button
      title="Switch View"
      onClick={() => setViewGrid((prev) => !prev)}
      className="relative flex flex-row justify-between items-center border border-border-color rounded-lg text-primary-text w-18 py-2 overflow-hidden cursor-pointer">
      {/* Sliding indicator */}
      <div
        className={`absolute w-1/2 h-full bg-cta-color rounded-lg transition-transform duration-300 ease-in-out z-0 ${
          viewGrid ? "translate-x-full" : "translate-x-0"
        }`}
      />

      {/* Icon wrapper */}
      <div className="flex w-full justify-between items-center relative z-10 px-2">
        <BsViewList
          className={`h-4 w-4 ${
            viewGrid ? "fill-primary-text" : "opacity-100 fill-white"
          }`}
        />
        <BsGrid
          className={`h-4 w-4 ${
            viewGrid ? "opacity-100 fill-white" : "fill-primary-text"
          }`}
        />
      </div>
    </button>
  );
};

export default ViewToggle;
