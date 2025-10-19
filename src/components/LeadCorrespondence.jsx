import React from "react";

const LeadCorrespondence = () => {
  return (
    <div className="flex items-stretch flex-col mr-5">
      <div className="flex p-3 flex-col">
        <div className="flex flex-row gap-3 justify-start items-center">
          <div className="rounded-full w-7 h-7 bg-blue-400"></div>
          <div className="rounded-full w-7 h-7 bg-green-400"></div>
          <p className="text-sm text-secondary-text">
            <span className="text-primary-text">Jamie Dryden</span> logged some
            new correspondence
          </p>
          <div className="rounded-full w-1 h-1 bg-muted/50"></div>
          <div className="rounded-md shadow-s flex flex-row items-center justify-between py-1 px-2 bg-tertiary-bg">
            <p className="text-xs text-secondary-text"># Pricing</p>
          </div>
          <p className="text-sm text-muted/50">9:20 AM</p>
        </div>
      </div>
      <div className="flex flex-row justify-start items-stretch">
        <div className="w-[2px] rounded-full bg-border-color ml-6.5"></div>
        <div className="bg-tertiary-bg mb-5 flex flex-row gap-4 shadow-s rounded-xl p-4 ml-10">
          <div className="bg-cta-color w-2 h-full"></div>
          <p className="text-sm text-primary-text">
            Spoke on the phone with David regarding pricing options. He is
            interested in our premium package but has some questions about the
            features included. Will follow up with an email summarizing our
            discussion and providing additional details.
          </p>
        </div>
      </div>
    </div>
  );
};

export default LeadCorrespondence;
