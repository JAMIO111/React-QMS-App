import React from "react";
import Logo from "@assets/dryden-logo.png";

const JobSheet = ({ job }) => {
  return (
    <div
      className="job-sheet"
      style={{
        width: "210mm",
        minHeight: "297mm",
        padding: "10mm",
        background: "#fff",
        color: "#000",
        fontFamily: "Arial, sans-serif",
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
        <h2 style={{ fontSize: "18px", borderBottom: "1px solid #000" }}>
          Changeover Job Sheet
        </h2>
      </section>
      <section className="flex gap-5">
        <section className="flex-1 border mb-7">
          <h2 className="p-1 border-b font-semibold bg-gray-200">
            Property Details
          </h2>
          <div className="p-2">
            <div className="flex gap-3 flex-row mb-1.5">
              <div className="flex-1 font-semibold">Name</div>
              <div className="flex-3 ">
                {job?.propertyName || "Lyndhurst Farm"}
              </div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-1 font-semibold">Address</div>
              <div className="flex-3 ">
                {job?.line_1 || "11 Broomylinn Place"}
              </div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-1 font-semibold"></div>
              <div className="flex-3 ">{job?.line_2 || "Eastfield Grange"}</div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-1 font-semibold"></div>
              <div className="flex-3 ">{job?.line_2 || "Cramlington"}</div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-1 font-semibold">Postcode</div>
              <div className="flex-3 ">{job?.postcode || "NE23 2SJ"}</div>
            </div>
          </div>
        </section>

        <section className="flex-1 border mb-7">
          <h2 className="p-1 border-b font-semibold bg-gray-200">
            Job Details
          </h2>
          <div className="p-2">
            <div className="flex gap-3 flex-row mb-1.5">
              <div className="flex-2 font-semibold">Job Date</div>
              <div className="flex-3 ">{job?.jobDate || "Fri, 9 Oct"}</div>
            </div>
            <div className="flex gap-3 flex-row">
              <div className="flex-2 font-semibold">Next Arrival</div>
              <div className="flex-3 ">{job?.nextArrival || "Mon, 12 Oct"}</div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Check Out</div>
              <div className="flex-3 ">{job?.checkOut || "11:00 AM"}</div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Check In</div>
              <div className="flex-3 ">{job?.checkIn || "3:00 PM"}</div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Return Guest</div>
              <div className="flex-3 ">{job?.returnGuest || "No"}</div>
            </div>
            <div className="flex gap-3 flex-row mt-1.5">
              <div className="flex-2 font-semibold">Type</div>
              <div className="flex-3 ">{job?.type || "Guest"}</div>
            </div>
          </div>
        </section>
      </section>

      <section style={{ marginBottom: "20px" }}>
        <h2 style={{ fontSize: "18px", borderBottom: "1px solid #000" }}>
          Materials Used
        </h2>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: "10px",
          }}>
          <thead>
            <tr style={{ backgroundColor: "#f0f0f0" }}>
              <th style={{ border: "1px solid #000", padding: "6px" }}>Item</th>
              <th style={{ border: "1px solid #000", padding: "6px" }}>
                Quantity
              </th>
              <th style={{ border: "1px solid #000", padding: "6px" }}>
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {(job?.materials || [{ item: "", qty: "", notes: "" }]).map(
              (mat, i) => (
                <tr key={i}>
                  <td style={{ border: "1px solid #ddd", padding: "6px" }}>
                    {mat.item}
                  </td>
                  <td style={{ border: "1px solid #ddd", padding: "6px" }}>
                    {mat.qty}
                  </td>
                  <td style={{ border: "1px solid #ddd", padding: "6px" }}>
                    {mat.notes}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </section>

      <section className="border" style={{ marginTop: "30px" }}>
        <h2 className="p-1 border-b font-semibold bg-gray-200">Sign-Off</h2>
        <div className="p-3 flex flex-col gap-7">
          <p>
            The above works have been completed and checked to my complete
            satisfaction.
          </p>
          <div className="flex h-18 gap-6 items-end">
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
};

export default JobSheet;
