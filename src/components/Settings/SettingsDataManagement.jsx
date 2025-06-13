import Accordion from "./Accordion";
import SettingsStatus from "./SettingsStatus";

const SettingsDataManagement = () => {
  return (
    <div className="flex flex-col pr-2 gap-3 w-full grow">
      <h2 className="text-primary-text text-2xl pb-2 font-semibold">
        Data Management
      </h2>
      <p className="text-secondary-text mb-2">
        Configure your businesses data settings and options here.
      </p>
      <Accordion
        title="Customer"
        subtitle="Add, remove and manage your customers"
      />
      <Accordion
        title="Supplier"
        subtitle="Add, remove and manage your suppliers"
      />
      <Accordion
        title="Product"
        subtitle="Add, remove and manage your products"
      />
      <Accordion
        title="Failure Mode"
        subtitle="Add, remove and manage failure modes"
      />
      <Accordion
        title="Sub-Failure Mode"
        subtitle="Add, remove and manage sub-failure modes"
      />
      <Accordion
        title="Process"
        subtitle="Manage your businesses processes and work stations"
      />
      <Accordion
        title="Status"
        subtitle="Manage your records statuses and their roles in the workflow">
        <SettingsStatus />
      </Accordion>
    </div>
  );
};

export default SettingsDataManagement;
