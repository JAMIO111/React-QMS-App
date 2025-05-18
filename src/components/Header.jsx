import React from "react";
import { BsSearch, BsBell } from "react-icons/bs";
import { GoMail } from "react-icons/go";
import HeaderIcon from "./HeaderIcon";
import SearchBar from "./ui/SearchBar";

const Header = () => {
  return (
    <header className="flex justify-between items-center border-b-1 border-border-color bg-secondary-bg px-4">
      <SearchBar />
      <div className="flex justify-between items-center py-2 gap-3">
        <HeaderIcon icon={GoMail} top={7} right={3} />
        <HeaderIcon icon={BsBell} top={8} right={8} />
        <div className="flex flex-col ml-3">
          <span className="text-primary-text text-right font-semibold">
            Jamie Dryden
          </span>
          <span className="text-right text-secondary-text">
            Quality Engineer
          </span>
        </div>
        <img
          className="rounded-lg border-1 border-gray-600 w-12 h-12"
          src="/Profile-img-cropped.jpg"
          alt="Profile Pic"
        />
      </div>
    </header>
  );
};

export default Header;
