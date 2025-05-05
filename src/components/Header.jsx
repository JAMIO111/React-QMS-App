import React from "react";
import { BsSearch, BsBell } from "react-icons/bs";
import { GoMail } from "react-icons/go";
import HeaderIcon from "./HeaderIcon";

const Header = () => {
  return (
    <header className="flex justify-between items-center border-b-1 border-border-color bg-secondary-bg px-4">
      <div className="flex w-1/3 relative items-center ">
        <BsSearch className="absolute fill-icon-color h-5 w-5 inset-x-4" />
        <input
          className="w-full h-10 border-border-color border-1 bg-text-input-color text-primary-text placeholder-secondary-text hover:border-border-dark-color focus:border-blue-300 focus:ring focus:ring-blue-200 focus:outline-none rounded-lg pl-12"
          type="text"
          placeholder="Search..."
        />
      </div>
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
