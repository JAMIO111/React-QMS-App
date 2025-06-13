const UserAvatarGroup = ({ users = [] }) => {
  const maxVisible = 5;
  const visibleUsers = users?.slice(0, maxVisible);
  const extraCount = users?.length - maxVisible;

  return (
    <div className="h-full w-full flex justify-start items-center">
      <div className="flex -space-x-3">
        {visibleUsers.map((user, index) =>
          user.avatar ? (
            <img
              key={index}
              src={user.avatar}
              alt={user.first_name + " " + user.surname}
              className="w-16 h-16 rounded-full border-2 border-white shadow-md object-cover"
              title={user.first_name + " " + user.surname}
            />
          ) : (
            <div
              key={index}
              className="w-16 h-16 flex items-center justify-center rounded-full bg-gray-300 text-gray-700 text-sm font-medium border-2 border-white shadow-md"
              title={user.first_name + " " + user.surname}>
              <p className="text-xl font-semibold">
                {user.first_name[0]}
                {user.surname[0]}
              </p>
            </div>
          )
        )}

        {extraCount > 0 && (
          <div className="w-16 h-16 flex items-center justify-center rounded-full bg-gray-300 text-gray-700 text-xl font-semibold border-2 border-white shadow-md">
            +{extraCount}
          </div>
        )}
      </div>
    </div>
  );
};

export default UserAvatarGroup;
