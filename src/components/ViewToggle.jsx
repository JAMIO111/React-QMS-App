import { BsViewList, BsGrid } from "react-icons/bs";

const ViewToggle = ({ viewGrid, setViewGrid }) => {
  return (
    <button
      title="Switch View"
      onClick={() => setViewGrid((prev) => !prev)}
      className="group relative flex flex-row justify-between items-center border border-border-color rounded-[7px] text-primary-text w-18 py-2 overflow-hidden cursor-pointer">
      {/* Sliding indicator */}
      <div
        className={`absolute w-1/2 h-full bg-cta-btn-bg border rounded-md border-cta-btn-border transition-transform duration-300 ease-in-out z-0
      group-hover:border-cta-btn-border-hover group-hover:bg-cta-btn-bg-hover
      ${viewGrid ? "translate-x-full" : "translate-x-0"}
    `}
      />

      {/* Icon wrapper */}
      <div className="flex w-full justify-between items-center relative z-10 px-2">
        <BsViewList
          className={`h-4 w-4 ${
            viewGrid ? "fill-primary-text" : "opacity-100 fill-primary-text"
          }`}
        />
        <BsGrid
          className={`h-4 w-4 ${
            viewGrid ? "opacity-100 fill-primary-text" : "fill-primary-text"
          }`}
        />
      </div>
    </button>
  );
};

export default ViewToggle;
