import { useState } from "react";
import { Outlet } from "react-router-dom";

const AuthPage = () => {
  return (
    <div className="flex flex-row items-center justify-between h-screen w-screen bg-primary-bg p-3 gap-3">
      <div className="flex flex-col items-center justify-center grow-1 h-full bg-secondary-bg shadow-md rounded-2xl">
        <Outlet />
      </div>
      <div className="w-fit h-full flex flex-row justify-end overflow-hidden rounded-2xl">
        <img
          className="max-lg:hidden h-full"
          src="/public/hero.jpg"
          alt="Brand Logo"
        />
      </div>
    </div>
  );
};

export default AuthPage;
