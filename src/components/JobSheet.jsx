import React from "react";
import Logo from "@assets/dryden-logo.png";
import { forwardRef } from "react";

const JobSheet = forwardRef(({ job }, ref) => {
  console.log("Job data:", job);
  return (
    <div
      ref={ref}
      className="job-sheet"
      style={{
        width: "210mm",
        minHeight: "297mm",
        padding: "10mm",
        background: "#fff",
        color: "#000",
        fontFamily: "Arial, sans-serif",
        borderBottom: "1px solid #000",
      }}>
      <header className="flex justify-between mb-6">
        <img src={Logo} width="350" alt="Company Logo" />
        <div className="flex flex-col items-end">
          <span className="font-bold">Dryden Services Limited</span>
          <span className="text-sm">North Seaton Industrial Estate,</span>
          <span className="text-sm">Unit 12A Armstrong Ct,</span>
          <span className="text-sm">Ashington, NE63 0YE</span>
        </div>
      </header>

      <section style={{ marginBottom: "20px" }}>
        <h2
          style={{
            fontSize: "18px",
            fontWeight: "semibold",
            borderBottom: "1px solid #000",
          }}>
          Job Sheet{" "}
          {(() => {
            switch (job?.propertyDetails?.service_type) {
              case "changeover":
                return "- Changeover";
              case "clean":
                return "- Clean Only";
              case "laundry":
                return "- Laundry Only";
              case "hot_tub":
                return "- Hot Tub";
              default:
                return "";
            }
          })()}
        </h2>
      </section>
      <section className="flex gap-5">
        <section className="flex-1 border mb-5">
          <h2 className="p-1 border-b font-semibold bg-gray-200">
            Property Details
          </h2>
          <div className="p-2">
            <div className="flex gap-3 flex-row mb-1.5">
              <div className="flex-1 font-semibold">Name</div>
              <div className="flex-3 ">{job?.propertyDetails?.name}</div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-1 font-semibold">Address</div>
              <div className="flex-3 ">{job?.propertyDetails?.line_1}</div>
            </div>

            {job?.propertyDetails?.line_2 && (
              <div className="flex gap-3 flex-row">
                <div className="flex-1 font-semibold"></div>
                <div className="flex-3 ">{job?.propertyDetails?.line_2}</div>
              </div>
            )}
            {job?.propertyDetails?.town && (
              <div className="flex gap-3 flex-row">
                <div className="flex-1 font-semibold"></div>
                <div className="flex-3 ">{job?.propertyDetails?.town}</div>
              </div>
            )}
            {job?.propertyDetails?.county && (
              <div className="flex gap-3 flex-row">
                <div className="flex-1 font-semibold"></div>
                <div className="flex-3 ">{job?.propertyDetails?.county}</div>
              </div>
            )}
            {job?.propertyDetails?.postcode && (
              <div className="flex gap-3 flex-row mt-1.5">
                <div className="flex-1 font-semibold">Postcode</div>
                <div className="flex-3 ">{job?.propertyDetails?.postcode}</div>
              </div>
            )}
          </div>
        </section>

        <section className="flex-1 border mb-5">
          <h2 className="p-1 border-b font-semibold bg-gray-200">
            Job Details
          </h2>
          <div className="p-2">
            <div className="flex gap-3 flex-row mb-1.5">
              <div className="flex-2 font-semibold">Job Date</div>
              <div className="flex-3 ">
                {new Date(job?.jobDate).toLocaleDateString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-2 font-semibold">Next Arrival</div>
              <div className="flex-3 ">
                {new Date(job?.nextArrival).toLocaleDateString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Check Out</div>
              <div className="flex-3 ">
                {job?.propertyDetails?.check_out
                  ? new Date(
                      `1970-01-01T${job.propertyDetails.check_out}`
                    ).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })
                  : "-"}
              </div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Check In</div>
              <div className="flex-3 ">
                {job?.propertyDetails?.check_in
                  ? new Date(
                      `1970-01-01T${job.propertyDetails.check_in}`
                    ).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    })
                  : "-"}
              </div>
            </div>
            {job?.bookingDetails && (
              <>
                <div className="flex gap-3 flex-row mt-1.5">
                  <div className="flex-2 font-semibold">Return Guest</div>
                  <div className="flex-3 ">
                    {job?.bookingDetails.is_return_guest ? "Yes" : "No"}
                  </div>
                </div>
                <div className="flex gap-3 flex-row mt-1.5">
                  <div className="flex-2 font-semibold">Type</div>
                  <div className="flex-3 ">
                    {job?.bookingDetails.is_owner_booking
                      ? "Owner Booking"
                      : "Guest Booking"}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </section>

      <section className="flex-1 border mb-5">
        <h2 className="p-1 border-b font-semibold bg-gray-200">
          Booking Details
        </h2>
        {job?.bookingDetails ? (
          <div className="flex gap-10">
            <div className="flex flex-col items-stretch p-2 flex-1">
              <div className="flex justify-between gap-3 flex-row ">
                <div className="font-semibold">
                  {`${job.bookingDetails.adults || 0} Adult${
                    (job.bookingDetails.adults || 0) !== 1 ? "s" : ""
                  }`}
                </div>
              </div>
              <div className="flex gap-3 justify-between flex-row">
                <div className=" font-semibold">
                  {`${job.bookingDetails.children || 0} Child${
                    (job.bookingDetails.children || 0) !== 1 ? "ren" : ""
                  }`}
                </div>
              </div>
              <div className="flex gap-3 justify-between flex-row">
                <div className=" font-semibold">
                  {`${job.bookingDetails.infants || 0} Infant${
                    (job.bookingDetails.infants || 0) !== 1 ? "s" : ""
                  }`}
                </div>
              </div>
            </div>
            <div className="p-2 flex-1">
              <div className="flex gap-3 justify-between flex-row ">
                <div className=" font-semibold">{`${
                  job.bookingDetails.pets || 0
                } Pet${(job.bookingDetails.pets || 0) !== 1 ? "s" : ""}`}</div>
              </div>
              <div className="flex gap-3 justify-between flex-row ">
                <div className="font-semibold">{`${
                  job.bookingDetails.stairgates || 0
                } Stairgate${
                  (job.bookingDetails.stairgates || 0) !== 1 ? "s" : ""
                }`}</div>
              </div>
              <div className="flex gap-3 justify-between flex-row">
                <div className=" font-semibold">{`${
                  job.bookingDetails.highchairs || 0
                } Highchair${
                  (job.bookingDetails.highchairs || 0) !== 1 ? "s" : ""
                }`}</div>
              </div>
            </div>
            <div className="p-2 flex-1">
              <div className="flex gap-3 justify-between flex-row ">
                <div className=" font-semibold">
                  {job.bookingDetails.cots || 0} Cot
                  {(job.bookingDetails.cots || 0) !== 1 ? "s" : ""}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-3">
            <p>No future booking available.</p>
          </div>
        )}
      </section>
      {(job?.propertyDetails.service_type === "changeover" ||
        job?.propertyDetails.service_type === "clean") && (
        <section className="flex-1 border mb-5">
          <h2 className="p-1 border-b font-semibold bg-gray-200">
            Quality Checks
          </h2>

          <div className="flex flex-wrap gap-10 p-2">
            {[
              ["Living Room", "Kitchen", "Bathrooms"],
              ["Bedrooms", "Hallways", "Staircases"],
              ["Garden", "Windows & Doors", "Check Key Safe"],
            ].map((group, i) => (
              <div key={i} className="flex flex-col flex-1 min-w-[200px] gap-1">
                {group.map((item) => (
                  <div
                    key={item}
                    className="flex justify-between gap-3 items-center flex-row">
                    <div className="h-5 w-5 border" />
                    <div className="flex-1 text-left font-semibold">{item}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="border" style={{ marginTop: "20px" }}>
        <h2 className="p-1 border-b font-semibold bg-gray-200">Sign-Off</h2>
        <div className="p-3 flex flex-col gap-7">
          <p>
            The above works have been completed and checked to my complete
            satisfaction.
          </p>
          <div className="flex h-12 gap-6 items-end">
            <div className="mb-7">Team Leader:</div>
            <div className="flex-1 items-stretch flex flex-col gap-1">
              <div className="border-b"></div>
              <p className="text-center text-sm">PRINT NAME</p>
            </div>

            <div className="flex-1 items-stretch flex flex-col gap-1">
              <div className="border-b"></div>
              <p className="text-center text-sm">SIGNATURE</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
});

export default JobSheet;
