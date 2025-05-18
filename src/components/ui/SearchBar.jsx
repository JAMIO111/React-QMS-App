import { CgClose } from "react-icons/cg";
import { BsSearch } from "react-icons/bs";
import { useGlobalSearch } from "../../contexts/SearchProvider";

const SearchBar = () => {
  const { searchTerm, setSearchTerm } = useGlobalSearch();

  return (
    <div className="flex w-1/3 relative items-center ">
      <BsSearch className="absolute fill-icon-color h-5 w-5 inset-x-4" />
      <input
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="w-full h-10 border-border-color border-1 bg-text-input-color text-primary-text placeholder-secondary-text hover:border-border-dark-color focus:border-blue-300 focus:ring focus:ring-blue-200 focus:outline-none rounded-lg pl-12"
        type="text"
        placeholder="Search..."
      />
      {searchTerm.length !== 0 && (
        <button
          onClick={() => {
            setSearchTerm("");
          }}
          className="absolute right-2 top-1/2 transform -translate-y-1/2 text-secondary-text rounded-lg p-2 hover:text-error-color cursor-pointer">
          <CgClose />
        </button>
      )}
    </div>
  );
};

export default SearchBar;
