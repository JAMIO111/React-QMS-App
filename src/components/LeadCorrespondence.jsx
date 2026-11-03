import { BsChatRightText } from "react-icons/bs";

const LeadCorrespondence = ({ correspondence }) => {
  return (
    <div className="flex items-stretch flex-col mr-5">
      <div className="flex p-3 flex-col">
        <div className="flex flex-row gap-3 justify-start items-center">
          <div className="rounded-full flex justify-center items-center w-9 h-9 bg-cta-color">
            <BsChatRightText className="w-4.5 h-4.5 text-white" />
          </div>
          <div className="rounded-full flex justify-center items-center p-0.5 bg-primary-text">
            {correspondence.created_by?.avatar ? (
              <img
                src={correspondence.created_by.avatar || ""}
                alt="Avatar"
                className="rounded-full object-cover w-8 h-8"
              />
            ) : (
              <div className="rounded-full w-8 h-8 bg-green-800">
                <p className="text-white text-sm flex items-center justify-center h-full">
                  {correspondence.created_by?.first_name?.charAt(0)}
                  {correspondence.created_by?.surname?.charAt(0)}
                </p>
              </div>
            )}
          </div>
          <p className="text-sm text-secondary-text">
            <span className="text-primary-text">
              {correspondence.created_by?.first_name || ""}{" "}
              {correspondence.created_by?.surname || ""}
            </span>{" "}
            logged some correspondence
          </p>
          <div className="rounded-full w-1 h-1 bg-muted/50"></div>
          <div className="rounded-md shadow-s flex flex-row items-center justify-between py-1 px-2 bg-tertiary-bg">
            <p className="text-xs text-secondary-text">
              # {correspondence.tag || "General"}
            </p>
          </div>
          <p className="text-sm text-muted/50">
            {new Date(correspondence.created_at).toLocaleTimeString([], {
              day: "2-digit",
              month: "short",
              year: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }) || ""}
          </p>
        </div>
      </div>
      <div className="flex flex-row justify-start items-stretch">
        <div className="w-[2px] rounded-full bg-border-color ml-6.5"></div>
        <div className="bg-tertiary-bg mb-5 gap-2 flex flex-row shadow-s rounded-xl p-3 ml-10">
          <div className="bg-cta-color rounded-full w-1 h-full"></div>
          <p className="text-sm p-1 text-primary-text">
            {correspondence.content || "No correspondence content provided."}
          </p>
        </div>
      </div>
    </div>
  );
};

export default LeadCorrespondence;
